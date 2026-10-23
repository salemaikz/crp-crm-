// События записей, сделок, входящих и импорта: № 16–21, 27–31 (PROCESS §3.5).

import type {
  AgreedSweepEvent,
  AppliedResult,
  AttendanceCorrectedEvent,
  AttendanceSweepEvent,
  AttendedEvent,
  BookingCancelledEvent,
  CallRecord,
  CardSnapshot,
  DealLostEvent,
  Effects,
  ImportAgreedEvent,
  InboundMessageEvent,
  InboundReactivateEvent,
  NoShowEvent,
  PurchaseCancelledEvent,
  PurchaseEvent,
  TransitionInput,
  TransitionResult,
} from './spec/types.js';
import { OUTCOME_ALLOWED_FROM } from './spec/types.js';
import {
  applied,
  callbackTask,
  closeEffects,
  commit,
  emptyEffects,
  leaveTasks,
  MINUTE_MS,
  ownerRecipient,
  reject,
  tlState,
} from './transitionKit.js';
import { resolveStepAt } from './retry.js';

/** Причина неявки: системная `no_show` с видом записи в `eventTypes`; нет такой — пустая строка. */
function noShowReason(input: TransitionInput, eventType: string | undefined): string {
  if (eventType === undefined) return '';
  const list = input.settings.reasons?.callback ?? [];
  const live = list.filter((r) => r.system === 'no_show' && r.eventTypes?.includes(eventType) === true);
  return (live.find((r) => !r.archived) ?? live[0])?.code ?? '';
}

/** Неявка: `callback` на шаг `noShowCallbackAt`, задача «перезаписать», значок сделки, уведомление (№ 16, 28). */
function noShowToCallback(input: TransitionInput, card: CardSnapshot, bookingId: string, actorId: string | null, eventType?: string): AppliedResult {
  const { now, settings, calendar } = input;
  const at = resolveStepAt(settings.noShowCallbackAt, now, calendar);
  const effects = emptyEffects();
  effects.tasks.push({ op: 'create', source: 'no_show', kind: 'call', assignee: ownerRecipient(card), dueAt: at, sourceKey: `no_show:${bookingId}` });
  effects.deals.push({ op: 'set_needs_rebook', bookingId, value: true });
  effects.notifications.push({ kind: 'no_show', to: ownerRecipient(card), dedupeKey: null });
  effects.timeline.push(tlState(now, actorId, card.state, 'callback', 'no_show'));
  // Касания не меняются: неявка — не звонок оператора.
  return applied(commit(card, { state: 'callback', nextCallAt: at, callbackReason: noShowReason(input, eventType), touchedInCrm: true }), effects);
}

/** № 16. */
export function applyNoShow(input: TransitionInput, card: CardSnapshot, e: NoShowEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  if (e.facts.hasOtherFutureBooking) return applied(card);
  return noShowToCallback(input, card, e.bookingId, input.actor.userId, e.eventType);
}

/** № 28 (только система): ночная проверка неотмеченной явки. */
export function applyAttendanceSweep(input: TransitionInput, card: CardSnapshot, e: AttendanceSweepEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  const { workdaysElapsed } = e.facts;
  if (workdaysElapsed <= 0) return applied(card);
  const limit = input.settings.autoNoShowWorkdays;
  const markerKey = `attendance_mark:${e.bookingId}:marker`;
  const leadKey = `attendance_mark:${e.bookingId}:lead`;
  if (limit === null || workdaysElapsed < limit) {
    const effects = emptyEffects();
    effects.tasks.push(
      { op: 'create', source: 'attendance_mark', kind: 'check', assignee: { user: e.markerUserId }, dueAt: input.now, sourceKey: markerKey },
      { op: 'create', source: 'attendance_mark', kind: 'check', assignee: { role: 'lead' }, dueAt: input.now, sourceKey: leadKey },
    );
    return applied(card, effects);
  }
  const close = [
    { op: 'close_by_key' as const, sourceKey: markerKey },
    { op: 'close_by_key' as const, sourceKey: leadKey },
  ];
  if (e.facts.hasOtherFutureBooking) {
    const effects = emptyEffects();
    effects.tasks.push(...close);
    return applied(card, effects);
  }
  const r = noShowToCallback(input, card, e.bookingId, null, e.eventType);
  r.effects.tasks.unshift(...close);
  return r;
}

/** № 17, 12.7. */
export function applyBookingCancelled(input: TransitionInput, card: CardSnapshot, e: BookingCancelledEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  if (e.facts.hasOtherFutureBooking) return applied(card);
  const { now, actor } = input;
  const effects = emptyEffects();
  if (e.reason === 'operator_error') {
    effects.tasks.push(callbackTask(card, e.opId, now));
    if (e.createdByOpId !== null) effects.deals.push({ op: 'lose_created_by', opId: e.createdByOpId, reasonCode: 'input_error' });
  } else {
    effects.tasks.push({ op: 'create', source: 'rebook', kind: 'call', assignee: ownerRecipient(card), dueAt: now, sourceKey: `rebook:${e.bookingId}` });
    effects.deals.push({ op: 'set_needs_rebook', bookingId: e.bookingId, value: true });
  }
  effects.timeline.push(tlState(now, actor.userId, card.state, 'callback', 'booking_cancelled'));
  return applied(commit(card, { state: 'callback', nextCallAt: now, touchedInCrm: true }), effects);
}

/** Задача «Записать на следующий шаг» (№ 18, 31). */
function nextStepTask(input: TransitionInput, card: CardSnapshot, bookingId: string): Effects['tasks'][number] {
  return {
    op: 'create',
    source: 'next_step',
    kind: 'call',
    assignee: ownerRecipient(card),
    dueAt: resolveStepAt(input.settings.nextStepTaskAt, input.now, input.calendar),
    sourceKey: `next_step:${bookingId}`,
  };
}

/** № 18. */
export function applyAttended(input: TransitionInput, card: CardSnapshot, e: AttendedEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  if (input.calendar.localDay(input.now) < e.eventDay) return reject('too_early');
  const effects = emptyEffects();
  effects.deals.push({ op: 'advance', stage: 'on_attended', bookingId: e.bookingId });
  if (!e.facts.hasNextFutureBooking) effects.tasks.push(nextStepTask(input, card, e.bookingId));
  return applied(card, effects);
}

/** № 19. */
export function applyPurchase(input: TransitionInput, card: CardSnapshot, e: PurchaseEvent): TransitionResult {
  if (card.state !== 'agreed' && card.state !== 'callback' && card.state !== 'client') return reject('invalid_transition');
  if (!Number.isInteger(e.amountKzt) || e.amountKzt < 0) return reject('amount_invalid', 'amountKzt');
  if (e.serviceTypeKey.trim() === '') return reject('service_type_required', 'serviceTypeKey');
  const effects = emptyEffects();
  effects.tasks.push(...leaveTasks(card.state, 'client'));
  effects.deals.push({ op: 'win', dealId: e.dealId, serviceTypeKey: e.serviceTypeKey, amountKzt: e.amountKzt, requestId: e.opId });
  if (card.state !== 'client') effects.timeline.push(tlState(input.now, input.actor.userId, card.state, 'client', 'purchase'));
  return applied(commit(card, { state: 'client', nextCallAt: null, touchedInCrm: true }), effects);
}

/** № 20. */
export function applyPurchaseCancelled(input: TransitionInput, card: CardSnapshot, e: PurchaseCancelledEvent): TransitionResult {
  if (card.state !== 'client') return reject('invalid_transition');
  if (e.comment.trim() === '') return reject('comment_required', 'comment');
  const { now, actor } = input;
  const effects = emptyEffects();
  effects.deals.push({ op: 'cancel_purchase', dealId: e.dealId });
  if (e.facts.hasOtherOpenDeal) {
    effects.timeline.push(tlState(now, actor.userId, card.state, 'agreed', 'purchase_cancelled'));
    return applied(commit(card, { state: 'agreed', touchedInCrm: true }), effects);
  }
  effects.tasks.push(callbackTask(card, e.opId, now));
  effects.timeline.push(tlState(now, actor.userId, card.state, 'callback', 'purchase_cancelled'));
  return applied(commit(card, { state: 'callback', nextCallAt: now, touchedInCrm: true }), effects);
}

/** № 21. */
export function applyDealLost(input: TransitionInput, card: CardSnapshot, e: DealLostEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  const { now, actor, settings, calendar } = input;
  const lose = { op: 'lose' as const, dealId: e.dealId, reasonGroup: 'deal_lost' as const, reasonCode: e.reasonCode };
  const effects = emptyEffects();
  if (e.facts.hasOtherOpenDeal) {
    effects.deals.push(lose);
    return applied(card, effects);
  }
  const common = { attempts: 0, closeReasonCode: e.reasonCode, closedAt: now, nextCallAt: null, touchedInCrm: true };
  effects.tasks.push(...closeEffects('written_off', e.reasonCode).tasks);
  effects.deals.push(lose);
  if (e.softness === 'soft') {
    const days = settings.returnDays.deal_lost_soft;
    effects.timeline.push(tlState(now, actor.userId, card.state, 'not_interested', 'deal_lost'));
    const returnAt = days === null ? null : calendar.addDays(now, days);
    return applied(commit(card, { ...common, state: 'not_interested', returnAt }), effects);
  }
  effects.bookings.push({ op: 'cancel_future', reason: 'not_target' });
  effects.timeline.push(tlState(now, actor.userId, card.state, 'not_target', 'deal_lost'));
  return applied(commit(card, { ...common, state: 'not_target', isTarget: 'no', returnAt: null }), effects);
}

/** № 27, системная часть. */
export function applyInboundMessage(input: TransitionInput, card: CardSnapshot, e: InboundMessageEvent): TransitionResult {
  const effects = emptyEffects();
  if (card.state === 'do_not_call') {
    effects.tasks.push({ op: 'create', source: 'dnc_inbound', kind: 'check', assignee: { role: 'lead' }, dueAt: null, sourceKey: `dnc_inbound:${e.opId}` });
    return applied(card, effects);
  }
  const missed = e.channel === 'call';
  effects.tasks.push({
    op: 'create',
    source: missed ? 'missed_call' : 'inbound_message',
    kind: missed ? 'call' : 'message',
    assignee: ownerRecipient(card),
    dueAt: input.now + input.settings.inboundReplyMinutes * MINUTE_MS,
    sourceKey: `inbound:${e.opId}`,
  });
  return applied(card, effects);
}

/** № 27, «Вернуть в работу». */
export function applyInboundReactivate(input: TransitionInput, card: CardSnapshot, e: InboundReactivateEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  if (card.state !== 'not_interested' && card.state !== 'written_off') return reject('invalid_transition');
  const { now, actor } = input;
  const effects = emptyEffects();
  effects.tasks.push(callbackTask(card, e.opId, now));
  effects.timeline.push(tlState(now, actor.userId, card.state, 'callback', 'inbound_reactivate'));
  const next = commit(card, {
    state: 'callback',
    attempts: 0,
    nextCallAt: now,
    returnAt: null,
    closeReasonCode: '',
    closedAt: null,
    touchedInCrm: true,
  });
  return applied(next, effects);
}

/** № 29 (только система). */
export function applyAgreedSweep(input: TransitionInput, card: CardSnapshot, e: AgreedSweepEvent): TransitionResult {
  if (card.state !== 'agreed') return reject('invalid_transition');
  if (e.facts.hasFutureBooking || e.facts.hasOpenOwnerTask) return applied(card);
  const { now, settings, calendar } = input;
  const effects = emptyEffects();
  effects.tasks.push({
    op: 'create',
    source: 'next_step',
    kind: 'call',
    assignee: ownerRecipient(card),
    dueAt: resolveStepAt(settings.nextStepTaskAt, now, calendar),
    sourceKey: `next_step:sweep:${card.id}:${calendar.localDay(now)}`,
  });
  return applied(card, effects);
}

/** № 30, 12.39 (только система). `touchedInCrm` импорт не трогает. */
export function applyImportAgreed(input: TransitionInput, card: CardSnapshot, e: ImportAgreedEvent): TransitionResult {
  if (card.touchedInCrm) return reject('touched_in_crm');
  const def = input.settings.outcomes.find((o) => o.key === e.outcomeKey);
  if (!def || def.kind !== 'agreed') return reject('outcome_unknown', 'outcomeKey');
  if (!OUTCOME_ALLOWED_FROM.agreed.includes(card.state)) return reject('invalid_transition');
  const { now } = input;
  const t = e.occurredAt;
  const found = e.bookingId !== null;
  const to = found ? 'agreed' : 'callback';
  const effects = emptyEffects();
  effects.tasks.push(...leaveTasks(card.state, to));
  if (found) {
    effects.deals.push({ op: 'ensure_open', stage: 'on_agreed', requestId: e.opId });
  } else {
    effects.tasks.push({ op: 'create', source: 'clarify_import', kind: 'call', assignee: ownerRecipient(card), dueAt: now, sourceKey: `clarify_import:${e.opId}` });
  }
  effects.timeline.push({
    kind: 'call',
    at: t,
    actorId: null,
    ref: { type: 'call', id: e.opId },
    data: { outcomeKind: 'agreed', fromState: card.state, toState: to, factReason: '' },
  });
  const next = commit(card, {
    state: to,
    attempts: 0,
    nextCallAt: found ? null : now,
    ...(found ? { isTarget: 'yes' as const } : {}),
    lastOutcomeCode: e.outcomeKey,
    lastOutcomeKind: 'agreed',
    lastOutcomeAt: t,
    callsTotal: card.callsTotal + 1,
    connectsTotal: card.connectsTotal + 1,
    firstConnectAt: Math.min(card.firstConnectAt ?? t, t),
    lastConnectAt: Math.max(card.lastConnectAt ?? t, t),
    lastTouchAt: Math.max(card.lastTouchAt ?? t, t),
  });
  const call: CallRecord = {
    id: e.opId,
    outcomeCode: e.outcomeKey,
    outcomeKind: 'agreed',
    reasonCode: '',
    lpr: '',
    callbackAt: null,
    callbackPrecision: 'time',
    phoneId: null,
    via: 'import',
    applied: 'applied',
    factReason: '',
    occurredAt: t,
    receivedAt: now,
    userId: null,
    ownerUserIdAtCall: card.ownerUserId,
  };
  return { status: 'applied', card: next, call, effects, warnings: [] };
}

/** № 31. */
export function applyAttendanceCorrected(input: TransitionInput, card: CardSnapshot, e: AttendanceCorrectedEvent): TransitionResult {
  if (card.state !== 'callback') return reject('invalid_transition');
  if (card.lastOutcomeAt !== null && card.lastOutcomeAt > e.noShowMarkedAt) return reject('stale');
  // Исправлять есть что, только пока открыта задача неявки этой записи (после № 16, 28, 33 с неявкой).
  if (e.facts.hasOpenNoShowTask === false) return reject('stale');
  const effects = emptyEffects();
  effects.tasks.push(...leaveTasks('callback', 'agreed'));
  if (!e.facts.hasNextFutureBooking) effects.tasks.push(nextStepTask(input, card, e.bookingId));
  effects.deals.push(
    { op: 'advance', stage: 'on_attended', bookingId: e.bookingId },
    { op: 'set_needs_rebook', bookingId: e.bookingId, value: false },
  );
  effects.timeline.push(tlState(input.now, input.actor.userId, 'callback', 'agreed', 'attendance_corrected'));
  return applied(commit(card, { state: 'agreed', nextCallAt: null, touchedInCrm: true }), effects);
}
