// Жизненный цикл карточки без звонка: вход, раздача, возврат в пул, закрытие из меню,
// возврат по сроку, «Вернуть в обзвон», снятие «Не звонить», передача, отсутствие, пропуск
// (PROCESS §3.5 № 1–3, 11–15, 22, 23, 25).

import type {
  AbsenceEvent,
  AppliedResult,
  AssignEvent,
  CardSnapshot,
  CloseFromMenuEvent,
  DncClearEvent,
  EnterEvent,
  ReleaseEvent,
  ReopenEvent,
  ReturnDueEvent,
  SkipEvent,
  TransferEvent,
  TransitionInput,
  TransitionResult,
} from './spec/types.js';
import { OUTCOME_ALLOWED_FROM, WORKING_STATES } from './spec/types.js';
import {
  applied,
  callbackTask,
  closeEffects,
  commit,
  dncEffects,
  dncSetEvent,
  emptyEffects,
  ownerRecipient,
  planDnc,
  reject,
  tlState,
} from './transitionKit.js';

/** № 1. */
export function applyEnter(input: TransitionInput, e: EnterEvent): TransitionResult {
  if (input.card !== null) return reject('invalid_transition');
  const card: CardSnapshot = {
    id: e.cardId,
    clientId: e.clientId,
    ownerUserId: null,
    actingUserId: null,
    actingUntilDay: '',
    state: 'new',
    holdReason: e.holdReason,
    attempts: 0,
    nextCallAt: null,
    returnAt: null,
    lpr: '',
    isTarget: '',
    lastOutcomeCode: '',
    lastOutcomeKind: '',
    lastOutcomeAt: null,
    closeReasonCode: '',
    closedAt: null,
    assignedAt: null,
    touchedInCrm: false,
    callsTotal: 0,
    connectsTotal: 0,
    noAnswerTotal: 0,
    firstConnectAt: null,
    lastConnectAt: null,
    lastTouchAt: null,
    version: 0,
    phones: e.phones,
  };
  const effects = emptyEffects();
  effects.timeline.push({ kind: 'card.created', at: input.now, actorId: input.actor.userId, ref: null, data: { sourceKey: e.sourceKey } });
  return applied(card, effects);
}

/** № 2. */
export function applyAssign(input: TransitionInput, card: CardSnapshot, e: AssignEvent): TransitionResult {
  if (e.seenVersion !== null && e.seenVersion !== card.version) return reject('version_conflict');
  if (card.state !== 'new' || card.ownerUserId !== null || card.holdReason !== '') return reject('invalid_transition');
  if (e.facts.capRemaining <= 0) return reject('cap_exhausted');
  const effects = emptyEffects();
  effects.assignLog.push({ kind: e.mode, fromUserId: null, toUserId: e.toUserId, countsToCap: input.settings.capIncludes.includes(e.mode) });
  effects.notifications.push({
    kind: 'cards_assigned',
    to: { user: e.toUserId },
    dedupeKey: e.runId !== null ? `assign:${e.runId}:${e.toUserId}` : null,
  });
  effects.timeline.push({
    kind: 'card.assigned',
    at: input.now,
    actorId: input.actor.userId,
    ref: null,
    data: { toUserId: e.toUserId, mode: e.mode },
  });
  return applied(commit(card, { ownerUserId: e.toUserId, assignedAt: input.now, touchedInCrm: true }), effects);
}

/** Нетронутая новая карточка с владельцем: можно вернуть в пул. */
export function isUntouchedNew(card: CardSnapshot): boolean {
  return card.state === 'new' && card.ownerUserId !== null && card.callsTotal === 0;
}

function releaseToPool(input: TransitionInput, card: CardSnapshot): AppliedResult {
  const effects = emptyEffects();
  effects.assignLog.push({ kind: 'release', fromUserId: card.ownerUserId, toUserId: null, countsToCap: false });
  effects.timeline.push({ kind: 'card.released', at: input.now, actorId: input.actor.userId, ref: null, data: { fromUserId: card.ownerUserId } });
  return applied(commit(card, { ownerUserId: null, assignedAt: null, touchedInCrm: true }), effects);
}

/** № 3. */
export function applyRelease(input: TransitionInput, card: CardSnapshot, e: ReleaseEvent): TransitionResult {
  if (e.seenVersion !== null && e.seenVersion !== card.version) return reject('version_conflict');
  if (!isUntouchedNew(card)) return reject('invalid_transition');
  return releaseToPool(input, card);
}

/** № 11, 12 из меню карточки: как итог того же вида, но без звонка и счётчиков. */
export function applyCloseFromMenu(input: TransitionInput, card: CardSnapshot, e: CloseFromMenuEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  if (!OUTCOME_ALLOWED_FROM[e.kind].includes(card.state)) return reject('invalid_transition');
  if (e.reasonCode.trim() === '') return reject('reason_required', 'reasonCode');
  const { now, actor } = input;
  const closing = closeEffects(e.kind, e.reasonCode);
  const effects = emptyEffects();
  effects.tasks.push(...closing.tasks);
  effects.deals.push(...closing.deals);
  effects.bookings.push(...closing.bookings);
  const common = { attempts: 0, closeReasonCode: e.reasonCode, closedAt: now, nextCallAt: null, returnAt: null, touchedInCrm: true };
  if (e.kind === 'not_target') {
    effects.timeline.push(tlState(now, actor.userId, card.state, 'not_target', 'menu_close'));
    return applied(commit(card, { ...common, state: 'not_target', isTarget: 'no' }), effects);
  }
  // «Не звонить»: без отмеченных номеров ставится основной.
  const ids = e.alsoDncPhoneIds.length > 0 ? e.alsoDncPhoneIds : card.phones.filter((p) => p.isPrimary).map((p) => p.id);
  const plan = planDnc(card.phones, ids);
  const dnc = dncEffects(plan, card.phones, e.opId, e.reasonCode);
  effects.tasks.push(...dnc.reviewTasks);
  effects.stopList.push(...dnc.stopList);
  effects.timeline.push(tlState(now, actor.userId, card.state, 'do_not_call', 'menu_close'), dncSetEvent(now, actor.userId, plan));
  return applied(commit(card, { ...common, state: 'do_not_call', phones: dnc.phones }), effects);
}

/** № 13, 12.23, 12.24 (только система). */
export function applyReturnDue(input: TransitionInput, card: CardSnapshot, e: ReturnDueEvent): TransitionResult {
  const { now } = input;
  if (card.state !== 'not_interested' || card.returnAt === null || card.returnAt > now) return reject('invalid_transition');
  const effects = emptyEffects();
  const cleared = { returnAt: null, closeReasonCode: '', closedAt: null };
  if (!e.facts.ownerActive) {
    effects.assignLog.push({ kind: 'release', fromUserId: card.ownerUserId, toUserId: null, countsToCap: false });
    effects.timeline.push(tlState(now, null, card.state, 'new', 'return_due'));
    return applied(commit(card, { ...cleared, state: 'new', ownerUserId: null, assignedAt: null }), effects);
  }
  if (e.facts.capRemaining <= 0) return reject('cap_exhausted');
  const owner = card.ownerUserId;
  effects.tasks.push(callbackTask(card, e.opId, now));
  effects.assignLog.push({ kind: 'return', fromUserId: null, toUserId: owner, countsToCap: input.settings.capIncludes.includes('return') });
  effects.notifications.push({ kind: 'card_returned', to: ownerRecipient(card), dedupeKey: `return:${e.runId}:${owner ?? ''}` });
  effects.timeline.push(tlState(now, null, card.state, 'callback', 'return_due'));
  return applied(commit(card, { ...cleared, state: 'callback', attempts: 0, nextCallAt: now, assignedAt: now }), effects);
}

/** № 14. */
export function applyReopen(input: TransitionInput, card: CardSnapshot, e: ReopenEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  if (card.state !== 'not_target' && card.state !== 'written_off' && card.state !== 'not_interested') return reject('invalid_transition');
  if (e.comment.trim() === '') return reject('comment_required', 'comment');
  const { now, actor } = input;
  const effects = emptyEffects();
  effects.tasks.push(callbackTask(card, e.opId, now));
  effects.notifications.push({ kind: 'card_reopened', to: ownerRecipient(card), dedupeKey: null });
  effects.timeline.push(tlState(now, actor.userId, card.state, 'callback', 'reopen'));
  const next = commit(card, {
    state: 'callback',
    attempts: 0,
    nextCallAt: now,
    returnAt: null,
    closeReasonCode: '',
    closedAt: null,
    isTarget: card.state === 'not_target' ? '' : card.isTarget,
    touchedInCrm: true,
  });
  return applied(next, effects);
}

/** № 15. */
export function applyDncClear(input: TransitionInput, card: CardSnapshot, e: DncClearEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  if (card.state !== 'do_not_call') return reject('invalid_transition');
  if (e.comment.trim() === '') return reject('comment_required', 'comment');
  const { now, actor } = input;
  // Номер, который держит другой клиент в «Не звонить», из стоп-листа не удаляется.
  const removable = card.phones.filter((p) => p.inStopList && !p.heldByOtherDncClient).map((p) => p.id);
  const effects = emptyEffects();
  effects.tasks.push(callbackTask(card, e.opId, now));
  effects.stopList.push(...removable.map((phoneId) => ({ op: 'remove' as const, phoneId })));
  effects.audit.push({ kind: 'dnc.cleared', data: { cardId: card.id, phonesRemoved: removable.length } });
  effects.timeline.push(tlState(now, actor.userId, card.state, 'callback', 'dnc_clear'), {
    kind: 'dnc.cleared',
    at: now,
    actorId: actor.userId,
    ref: null,
    data: { phonesRemoved: removable.length },
  });
  const next = commit(card, {
    state: 'callback',
    nextCallAt: now,
    closeReasonCode: '',
    closedAt: null,
    returnAt: null,
    phones: card.phones.map((p) => (removable.includes(p.id) ? { ...p, inStopList: false } : p)),
    touchedInCrm: true,
  });
  return applied(next, effects);
}

/** № 22. */
export function applyTransfer(input: TransitionInput, card: CardSnapshot, e: TransferEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  if (!e.facts.toUserActive) return reject('user_inactive', 'toUserId');
  const effects = emptyEffects();
  effects.tasks.push({ op: 'reassign_open', to: e.toUserId });
  effects.deals.push({ op: 'reassign_open', to: e.toUserId });
  effects.bookings.push({ op: 'reassign_future', to: e.toUserId });
  effects.assignLog.push({ kind: 'transfer', fromUserId: card.ownerUserId, toUserId: e.toUserId, countsToCap: false });
  effects.notifications.push({ kind: 'client_transferred', to: { user: e.toUserId }, dedupeKey: null });
  effects.timeline.push({
    kind: 'card.transferred',
    at: input.now,
    actorId: input.actor.userId,
    ref: null,
    data: { fromUserId: card.ownerUserId, toUserId: e.toUserId },
  });
  const next = commit(card, { ownerUserId: e.toUserId, actingUserId: null, actingUntilDay: '', touchedInCrm: true });
  return applied(next, effects);
}

/** № 23. */
export function applyAbsence(input: TransitionInput, card: CardSnapshot, e: AbsenceEvent): TransitionResult {
  if (isUntouchedNew(card)) return releaseToPool(input, card);
  if (card.state !== 'retry' && card.state !== 'callback' && card.state !== 'agreed' && card.state !== 'client') {
    return reject('invalid_transition');
  }
  const effects = emptyEffects();
  effects.assignLog.push({ kind: 'absence', fromUserId: card.ownerUserId, toUserId: e.actingUserId, countsToCap: false });
  effects.timeline.push({
    kind: 'card.acting',
    at: input.now,
    actorId: input.actor.userId,
    ref: null,
    data: { actingUserId: e.actingUserId, untilDay: e.untilDay },
  });
  return applied(commit(card, { actingUserId: e.actingUserId, actingUntilDay: e.untilDay, touchedInCrm: true }), effects);
}

/** № 25. Карточка не меняется, пропуск записывается за местные сутки. */
export function applySkip(input: TransitionInput, card: CardSnapshot, e: SkipEvent): TransitionResult {
  if (!(WORKING_STATES as readonly string[]).includes(card.state)) return reject('invalid_transition');
  if (e.facts.skipsToday >= input.settings.skipLimit) return reject('skip_limit');
  const effects = emptyEffects();
  effects.skips.push({ opId: e.opId, day: input.calendar.localDay(input.now) });
  return applied(card, effects);
}
