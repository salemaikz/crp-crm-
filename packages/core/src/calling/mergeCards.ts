// Слияние клиентов (PROCESS 3.5 № 24, правило 12.20): `card` — остающаяся, `event.other` — уходящая.

import type { CardSnapshot, MergeEvent, TransitionInput, TransitionResult, UserId } from './spec/types.js';
import { applied, closeEffects, CLOSED_STATES, commit, emptyEffects, reject } from './transitionKit.js';

type Donor = 'survivor' | 'other';

/** Донор состояния: «Не звонить» побеждает, иначе более поздний итог (null — самый ранний, равенство — остающаяся). */
function pickDonor(a: CardSnapshot, b: CardSnapshot): Donor {
  if (a.state === 'do_not_call') return 'survivor';
  if (b.state === 'do_not_call') return 'other';
  return (b.lastOutcomeAt ?? -Infinity) > (a.lastOutcomeAt ?? -Infinity) ? 'other' : 'survivor';
}

const minNullable = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const maxNullable = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export function applyMerge(input: TransitionInput, card: CardSnapshot, e: MergeEvent): TransitionResult {
  if (e.seenVersion !== card.version) return reject('version_conflict');
  const { now, actor } = input;
  const other = e.other;
  const stateDonor = pickDonor(card, other);
  const s = stateDonor === 'other' ? other : card;
  const ownerDonor = e.ownerFrom === 'auto' ? s : e.ownerFrom === 'other' ? other : card;

  const next = commit(card, {
    state: s.state,
    holdReason: s.holdReason,
    attempts: s.attempts,
    nextCallAt: s.nextCallAt,
    // Срок, причина и касания перезвона едут вместе с donor-ом: иначе «день» станет «по времени» (§4.3).
    nextCallPrecision: s.nextCallPrecision,
    callbackReason: s.callbackReason,
    callbackTouches: s.callbackTouches,
    returnAt: s.returnAt,
    lpr: s.lpr,
    isTarget: s.isTarget,
    lastOutcomeCode: s.lastOutcomeCode,
    lastOutcomeKind: s.lastOutcomeKind,
    lastOutcomeAt: s.lastOutcomeAt,
    closeReasonCode: s.closeReasonCode,
    closedAt: s.closedAt,
    ownerUserId: ownerDonor.ownerUserId,
    actingUserId: ownerDonor.actingUserId,
    actingUntilDay: ownerDonor.actingUntilDay,
    assignedAt: ownerDonor.assignedAt,
    callsTotal: card.callsTotal + other.callsTotal,
    connectsTotal: card.connectsTotal + other.connectsTotal,
    noAnswerTotal: card.noAnswerTotal + other.noAnswerTotal,
    firstConnectAt: minNullable(card.firstConnectAt, other.firstConnectAt),
    lastConnectAt: maxNullable(card.lastConnectAt, other.lastConnectAt),
    lastTouchAt: maxNullable(card.lastTouchAt, other.lastTouchAt),
    touchedInCrm: card.touchedInCrm || other.touchedInCrm,
    phones: [...card.phones, ...other.phones.map((p) => ({ ...p, isPrimary: false }))],
  });

  const effects = emptyEffects();
  // Переход остающейся карточки в закрытое состояние: те же эффекты, что у итога этого вида.
  if (card.state !== next.state && CLOSED_STATES.includes(next.state)) {
    const kind = next.state as 'not_interested' | 'not_target' | 'do_not_call' | 'written_off';
    const closing = closeEffects(kind, next.closeReasonCode);
    effects.tasks.push(...closing.tasks);
    effects.deals.push(...closing.deals);
    effects.bookings.push(...closing.bookings);
  }
  // Смена владельца: переназначение, журнал, уведомление каждому потерявшему.
  const finalOwner = next.ownerUserId;
  const losers: UserId[] = [];
  for (const u of [card.ownerUserId, other.ownerUserId]) {
    if (u !== null && u !== finalOwner && !losers.includes(u)) losers.push(u);
  }
  if (losers.length > 0 && finalOwner !== null) {
    effects.tasks.push({ op: 'reassign_open', to: finalOwner });
    effects.deals.push({ op: 'reassign_open', to: finalOwner });
    effects.bookings.push({ op: 'reassign_future', to: finalOwner });
    effects.assignLog.push({ kind: 'merge', fromUserId: losers[0] ?? null, toUserId: finalOwner, countsToCap: false });
  }
  for (const u of losers) effects.notifications.push({ kind: 'card_merged', to: { user: u }, dedupeKey: null });
  effects.audit.push({ kind: 'card.merged', data: { cardId: card.id, otherCardId: other.id } });
  effects.timeline.push({
    kind: 'card.merged',
    at: now,
    actorId: actor.userId,
    ref: null,
    data: { otherCardId: other.id, stateFrom: stateDonor },
  });
  return applied(next, effects);
}
