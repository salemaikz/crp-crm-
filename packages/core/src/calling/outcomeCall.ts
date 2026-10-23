// Итог звонка (`type: 'outcome'`): порядок проверок и применение (spec/README.md, PROCESS §3.5 № 4–12, §12).

import type {
  AppliedResult,
  CallingSettings,
  CallRecord,
  CardSnapshot,
  Effects,
  FactOnlyResult,
  FactReason,
  OutcomeDef,
  OutcomeEvent,
  PhoneSnapshot,
  ReasonDef,
  TaskEffect,
  TimelineEffect,
  TransitionInput,
  TransitionResult,
  Warning,
} from './spec/types.js';
import {
  CONNECTED_KINDS,
  LPR_ON_CONTACT_KINDS,
  OCCURRED_FUTURE_TOLERANCE_MS,
  OUTCOME_ALLOWED_FROM,
} from './spec/types.js';
import {
  callbackTask,
  closeEffects,
  commit,
  dncEffects,
  dncSetEvent,
  emptyEffects,
  HOUR_MS,
  leaveTasks,
  MINUTE_MS,
  ownerRecipient,
  planDnc,
  reject,
  writeOffEffects,
} from './transitionKit.js';
import { planNoAnswer } from './retry.js';

type Fields = Partial<CardSnapshot>;

/** Группа причин итога: из справочника итога, иначе по виду (для видов, у которых группа совпадает с ним). */
function reasonGroupOf(def: OutcomeDef): string | null {
  if (def.kind === 'callback') return 'callback';
  if (def.reasonGroup !== undefined) return def.reasonGroup;
  const same: readonly string[] = ['not_interested', 'not_target', 'do_not_call', 'bad_number'];
  return same.includes(def.kind) ? def.kind : null;
}

/** Причина должна быть в группе (архивная допустима) и не быть системной (`manual: false`). */
function reasonKnown(group: string | null, code: string, settings: CallingSettings): boolean {
  if (group === null || settings.reasons === undefined) return true;
  const list = (settings.reasons as Record<string, ReasonDef[] | undefined>)[group];
  if (list === undefined) return true;
  const r = list.find((x) => x.code === code);
  return r !== undefined && r.manual !== false;
}

/** Причина, которую запишет итог `callback`: старый контракт (нет точности) её не пишет. */
function callbackReasonOf(e: OutcomeEvent): string {
  return e.callbackPrecision === undefined ? '' : e.reasonCode;
}

/** Проверки полей итога (шаг 7 порядка проверок). */
function validateFields(e: OutcomeEvent, def: OutcomeDef, card: CardSnapshot, t: number, tolMin: number, input: TransitionInput) {
  const { settings } = input;
  const kind = def.kind;
  const v2Callback = kind === 'callback' && e.callbackPrecision !== undefined;
  const group = reasonGroupOf(def);
  if (v2Callback) {
    // Новый контракт: обязательность задаёт `calling.callbackReason`, а не `requires.reason` итога.
    if (settings.callbackReason?.required === true && e.reasonCode.trim() === '') return reject('reason_required', 'reasonCode');
    if (e.reasonCode !== '' && !reasonKnown(group, e.reasonCode, settings)) return reject('reason_unknown', 'reasonCode');
  } else if (kind !== 'callback' || def.requires.reason) {
    if (def.requires.reason && e.reasonCode.trim() === '') return reject('reason_required', 'reasonCode');
    if (kind !== 'callback' && e.reasonCode !== '' && !reasonKnown(group, e.reasonCode, settings)) return reject('reason_unknown', 'reasonCode');
  }
  const lprNeeded = def.requires.lpr || (settings.lprRequiredOnContact && (LPR_ON_CONTACT_KINDS as readonly string[]).includes(kind));
  if (lprNeeded && e.lpr === '') return reject('lpr_required', 'lpr');
  if (e.lpr === 'no' && settings.lprNoRequiresInfo && !e.lprInfoFilled && !e.hasNote) return reject('lpr_info_required', 'lprInfo');
  if (kind === 'callback' || def.requires.callbackAt) {
    if (e.callbackAt === null) return reject('callback_at_required', 'callbackAt');
    if (kind === 'callback') {
      // Точность «день»: сравниваются сутки, сегодняшний срок допустим.
      const past = e.callbackPrecision === 'day' ? input.calendar.localDay(e.callbackAt) < input.calendar.localDay(t) : e.callbackAt < t - tolMin * MINUTE_MS;
      if (past) return reject('callback_in_past', 'callbackAt');
    }
  }
  if (kind === 'agreed' || def.requires.agreement) {
    const a = e.agreement;
    if (a === null) return reject('agreement_required', 'agreement');
    if (def.requires.contact && a.contactId === null) return reject('contact_required', 'agreement.contactId');
    if (a.bookingId === null && a.agreedDueAt === null) return reject('agreement_required', 'agreement');
  }
  if (kind === 'bad_number' && (e.phoneId === null || !card.phones.some((p) => p.id === e.phoneId))) {
    return reject('phone_required', 'phoneId');
  }
  return null;
}

/** Счётчики звонка: обновляются и у применённого, и у `fact_only`. */
function counters(card: CardSnapshot, kind: OutcomeDef['kind'], t: number): Fields {
  const connected = (CONNECTED_KINDS as readonly string[]).includes(kind);
  return {
    callsTotal: card.callsTotal + 1,
    connectsTotal: card.connectsTotal + (connected ? 1 : 0),
    noAnswerTotal: card.noAnswerTotal + (kind === 'no_answer' ? 1 : 0),
    firstConnectAt: connected ? Math.min(card.firstConnectAt ?? t, t) : card.firstConnectAt,
    lastConnectAt: connected ? Math.max(card.lastConnectAt ?? t, t) : card.lastConnectAt,
    lastTouchAt: Math.max(card.lastTouchAt ?? t, t),
    touchedInCrm: true,
  };
}

function callRecord(
  e: OutcomeEvent,
  def: OutcomeDef,
  t: number,
  userId: string | null,
  ownerAtCall: string | null,
  status: 'applied' | 'fact_only',
  factReason: FactReason,
): CallRecord {
  return {
    id: e.opId,
    outcomeCode: e.outcomeKey,
    outcomeKind: def.kind,
    reasonCode: def.kind === 'callback' ? callbackReasonOf(e) : e.reasonCode,
    lpr: e.lpr,
    callbackAt: e.callbackAt,
    callbackPrecision: e.callbackPrecision ?? 'time',
    phoneId: e.phoneId,
    via: e.via,
    applied: status,
    factReason,
    occurredAt: t,
    receivedAt: e.receivedAt,
    userId,
    ownerUserIdAtCall: ownerAtCall,
  };
}

function tlCall(e: OutcomeEvent, def: OutcomeDef, t: number, actorId: string | null, card: CardSnapshot, to: CardSnapshot['state'], fr: FactReason): TimelineEffect {
  return {
    kind: 'call',
    at: t,
    actorId,
    ref: { type: 'call', id: e.opId },
    data: { outcomeKind: def.kind, fromState: card.state, toState: to, factReason: fr },
  };
}

interface Applied {
  fields: Fields;
  effects: Effects;
  warnings: Warning[];
  extraTimeline: TimelineEffect[];
}

/** Применение итога по виду (шаг 11). */
function applyKind(e: OutcomeEvent, def: OutcomeDef, card: CardSnapshot, t: number, input: TransitionInput): Applied {
  const { settings, calendar } = input;
  const effects = emptyEffects();
  const warnings: Warning[] = [];
  const extraTimeline: TimelineEffect[] = [];
  const actorId = input.actor.userId;
  const base: Fields = {
    lastOutcomeCode: e.outcomeKey,
    lastOutcomeKind: def.kind,
    lastOutcomeAt: t,
    ...(e.lpr !== '' ? { lpr: e.lpr } : {}),
    ...(e.markTarget ? { isTarget: 'yes' as const } : {}),
  };
  const closed = (reason: string): Fields => ({ closeReasonCode: reason, closedAt: t, nextCallAt: null });

  switch (def.kind) {
    case 'no_answer': {
      const plan = planNoAnswer(card.attempts, t, settings.retry, calendar);
      if (plan.kind === 'write_off') {
        const f = { ...base, state: 'written_off' as const, attempts: plan.attempts, ...closed('no_answer_limit') };
        const wo = writeOffEffects('no_answer_limit', settings);
        effects.tasks.push(...leaveTasks(card.state, 'written_off'));
        effects.deals.push(...wo.deals);
        return { fields: f, effects, warnings, extraTimeline };
      }
      const f = { ...base, state: 'retry' as const, attempts: plan.attempts, nextCallAt: plan.nextCallAt };
      effects.tasks.push(...leaveTasks(card.state, 'retry'));
      return { fields: f, effects, warnings, extraTimeline };
    }
    case 'bad_number': {
      const phones: PhoneSnapshot[] = card.phones.map((p) => (p.id === e.phoneId ? { ...p, isWorking: false, isPrimary: false } : p));
      const prevPrimary = card.phones.find((p) => p.isPrimary)?.id ?? null;
      const next = phones.find((p) => p.isWorking && !p.inStopList) ?? null;
      const withPrimary = phones.map((p) => ({ ...p, isPrimary: next !== null && p.id === next.id }));
      extraTimeline.push({ kind: 'phone.not_working', at: t, actorId, ref: null, data: { phoneId: e.phoneId } });
      if (next !== null) {
        if (next.id !== prevPrimary) extraTimeline.push({ kind: 'phone.primary', at: t, actorId, ref: null, data: { phoneId: next.id } });
        effects.tasks.push(...leaveTasks(card.state, 'retry'));
        return { fields: { ...base, state: 'retry', nextCallAt: t, phones: withPrimary }, effects, warnings, extraTimeline };
      }
      effects.tasks.push(...leaveTasks(card.state, 'written_off'));
      effects.deals.push(...writeOffEffects('no_working_phone', settings).deals);
      return { fields: { ...base, state: 'written_off', ...closed('no_working_phone'), phones: withPrimary }, effects, warnings, extraTimeline };
    }
    case 'callback': {
      const at = e.callbackAt as number;
      if (!calendar.isInCallWindow(at)) warnings.push('callback_outside_work_hours');
      const precision = e.callbackPrecision ?? 'time';
      effects.tasks.push(...leaveTasks(card.state, 'callback'), callbackTask(card, e.opId, at, precision));
      // Повторный «Перезвонить» из `callback` — тоже касание: цикл не сбрасывается (недозвон между ними не в счёт).
      const fields: Fields = {
        ...base,
        state: 'callback',
        attempts: 0,
        nextCallAt: at,
        nextCallPrecision: precision,
        callbackReason: callbackReasonOf(e),
        callbackTouches: card.callbackTouches + 1,
      };
      return { fields, effects, warnings, extraTimeline };
    }
    case 'agreed': {
      effects.tasks.push(...leaveTasks(card.state, 'agreed'));
      const a = e.agreement;
      if (a !== null && a.bookingId === null && a.agreedDueAt !== null) {
        effects.tasks.push({
          op: 'create',
          source: 'agreement',
          kind: 'call',
          assignee: ownerRecipient(card),
          dueAt: a.agreedDueAt,
          sourceKey: `agreement:${e.opId}`,
        });
      }
      effects.deals.push({ op: 'ensure_open', stage: 'on_agreed', requestId: e.opId });
      return { fields: { ...base, state: 'agreed', attempts: 0, isTarget: 'yes', nextCallAt: null }, effects, warnings, extraTimeline };
    }
    case 'not_interested': {
      const days = settings.returnDays.not_interested;
      const closing = closeEffects('not_interested', e.reasonCode);
      effects.tasks.push(...closing.tasks);
      effects.deals.push(...closing.deals);
      const returnAt = days === null ? null : calendar.addDays(t, days);
      return { fields: { ...base, state: 'not_interested', attempts: 0, returnAt, ...closed(e.reasonCode) }, effects, warnings, extraTimeline };
    }
    case 'not_target': {
      const closing = closeEffects('not_target', e.reasonCode);
      effects.tasks.push(...closing.tasks);
      effects.deals.push(...closing.deals);
      effects.bookings.push(...closing.bookings);
      return {
        fields: { ...base, state: 'not_target', attempts: 0, isTarget: 'no', returnAt: null, ...closed(e.reasonCode) },
        effects,
        warnings,
        extraTimeline,
      };
    }
    case 'do_not_call': {
      const closing = closeEffects('do_not_call', e.reasonCode);
      const ids = [...(e.phoneId !== null ? [e.phoneId] : []), ...e.alsoDncPhoneIds];
      const plan = planDnc(card.phones, ids);
      const dnc = dncEffects(plan, card.phones, e.opId, e.reasonCode);
      effects.tasks.push(...closing.tasks, ...dnc.reviewTasks);
      effects.deals.push(...closing.deals);
      effects.bookings.push(...closing.bookings);
      effects.stopList.push(...dnc.stopList);
      extraTimeline.push(dncSetEvent(t, actorId, plan));
      return {
        fields: { ...base, state: 'do_not_call', attempts: 0, returnAt: null, phones: dnc.phones, ...closed(e.reasonCode) },
        effects,
        warnings,
        extraTimeline,
      };
    }
  }
}

/** Итог звонка: полный порядок проверок из README спецификации. */
export function applyOutcomeEvent(input: TransitionInput, e: OutcomeEvent): TransitionResult {
  const { card, actor, settings } = input;
  // 1. Повтор opId.
  if (e.facts.sameOpId !== null) {
    return { status: 'duplicate', applied: e.facts.sameOpId.applied, factReason: e.facts.sameOpId.factReason };
  }
  // 2–3. Карточка и итог.
  if (card === null) return reject('not_found');
  const def = settings.outcomes.find((o) => o.key === e.outcomeKey);
  if (!def) return reject('outcome_unknown', 'outcomeKey');

  // 4. Время звонка в окне [приём − offlineWindowHours, приём + 5 мин].
  const warnings: Warning[] = [];
  const lo = e.receivedAt - settings.offlineWindowHours * HOUR_MS;
  const hi = e.receivedAt + OCCURRED_FUTURE_TOLERANCE_MS;
  const t = Math.min(Math.max(e.occurredAt, lo), hi);
  if (t !== e.occurredAt) warnings.push('occurred_at_clamped');

  // 5. Архивный итог принимается ещё offlineWindowHours.
  if (def.archived && def.archivedAt !== null && e.receivedAt > def.archivedAt + settings.offlineWindowHours * HOUR_MS) {
    return reject('outcome_archived', 'outcomeKey');
  }

  // 6. Права и владелец.
  if (actor.kind === 'system' || actor.scope === 'relation') return reject('forbidden');
  let ownerChanged = false;
  if (actor.scope === 'own') {
    const isOwner = actor.userId !== null && (card.ownerUserId === actor.userId || card.actingUserId === actor.userId);
    if (!isOwner) {
      if (e.facts.actorWasOwnerAtCall) ownerChanged = true;
      else return reject('not_found');
    }
  }

  // 7. Поля.
  const bad = validateFields(e, def, card, t, settings.callbackPastToleranceMin, input);
  if (bad) return bad;

  const ownerAtCall = ownerChanged ? actor.userId : card.ownerUserId;
  const fact = (reason: 'owner_changed' | 'stale'): FactOnlyResult => {
    const effects = emptyEffects();
    if (def.kind === 'do_not_call') {
      effects.tasks.push(reviewTask('lead', e.opId));
    } else if (reason === 'owner_changed') {
      effects.tasks.push(reviewTask(card.ownerUserId, e.opId));
    }
    effects.timeline.push(tlCall(e, def, t, actor.userId, card, card.state, reason));
    return {
      status: 'fact_only',
      factReason: reason,
      card: commit(card, counters(card, def.kind, t)),
      call: callRecord(e, def, t, actor.userId, ownerAtCall, 'fact_only', reason),
      effects,
      warnings,
    };
  };

  // 8–10. Факт без смены состояния.
  if (ownerChanged) return fact('owner_changed');
  if (card.lastOutcomeAt !== null && t <= card.lastOutcomeAt) return fact('stale');
  if (!OUTCOME_ALLOWED_FROM[def.kind].includes(card.state)) return fact('stale');

  // 11. Применить.
  const r = applyKind(e, def, card, t, input);
  const next = commit(card, { ...counters(card, def.kind, t), ...r.fields });
  const effects = r.effects;
  effects.timeline.push(tlCall(e, def, t, actor.userId, card, next.state, ''), ...r.extraTimeline);
  const result: AppliedResult = {
    status: 'applied',
    card: next,
    call: callRecord(e, def, t, actor.userId, ownerAtCall, 'applied', ''),
    effects,
    warnings: [...warnings, ...r.warnings],
  };
  return result;
}

function reviewTask(assignee: string | null | 'lead', opId: string): TaskEffect {
  return {
    op: 'create',
    source: 'review',
    kind: 'check',
    assignee: assignee === null || assignee === 'lead' ? { role: 'lead' } : { user: assignee },
    dueAt: null,
    sourceKey: `review:${opId}`,
  };
}
