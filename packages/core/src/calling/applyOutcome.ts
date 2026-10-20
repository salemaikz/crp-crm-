// Машина состояний карточки обзвона: чистая функция `applyOutcome` (K1d).
// Спецификация: spec/types.ts, spec/vectors.ts, spec/README.md; PROCESS §3, §12.
// Без БД, сети, Date.now() и случайных id: всё приходит во входе, всё записываемое уходит в результате.

import type { ApplyOutcome, CardEvent, CardSnapshot, TransitionInput, TransitionResult } from './spec/types.js';
import {
  applyAgreedSweep,
  applyAttendanceCorrected,
  applyAttendanceSweep,
  applyAttended,
  applyBookingCancelled,
  applyDealLost,
  applyImportAgreed,
  applyInboundMessage,
  applyInboundReactivate,
  applyNoShow,
  applyPurchase,
  applyPurchaseCancelled,
} from './bookingEvents.js';
import {
  applyAbsence,
  applyAssign,
  applyCloseFromMenu,
  applyDncClear,
  applyEnter,
  applyRelease,
  applyReopen,
  applyReturnDue,
  applySkip,
  applyTransfer,
} from './cardLifecycle.js';
import { applyMerge } from './mergeCards.js';
import { applyOutcomeEvent } from './outcomeCall.js';
import { reject } from './transitionKit.js';

/** События, которые может выпустить только система. */
const SYSTEM_ONLY: ReadonlySet<CardEvent['type']> = new Set([
  'return_due',
  'attendance_sweep',
  'agreed_sweep',
  'import_agreed',
  'inbound_message',
]);

/** События, для которых оператор с охватом `own` должен владеть карточкой. */
const OWNER_ONLY: ReadonlySet<CardEvent['type']> = new Set(['skip', 'inbound_reactivate', 'booking_cancelled']);

/** `seenVersion` события, если оно его несёт. */
function seenVersionOf(e: CardEvent): number | null {
  return 'seenVersion' in e ? e.seenVersion : null;
}

function dispatch(input: TransitionInput, card: CardSnapshot): TransitionResult {
  const e = input.event;
  switch (e.type) {
    case 'assign': return applyAssign(input, card, e);
    case 'release': return applyRelease(input, card, e);
    case 'close_from_menu': return applyCloseFromMenu(input, card, e);
    case 'return_due': return applyReturnDue(input, card, e);
    case 'reopen': return applyReopen(input, card, e);
    case 'dnc_clear': return applyDncClear(input, card, e);
    case 'no_show': return applyNoShow(input, card, e);
    case 'attendance_sweep': return applyAttendanceSweep(input, card, e);
    case 'booking_cancelled': return applyBookingCancelled(input, card, e);
    case 'attended': return applyAttended(input, card, e);
    case 'purchase': return applyPurchase(input, card, e);
    case 'purchase_cancelled': return applyPurchaseCancelled(input, card, e);
    case 'deal_lost': return applyDealLost(input, card, e);
    case 'transfer': return applyTransfer(input, card, e);
    case 'absence': return applyAbsence(input, card, e);
    case 'merge': return applyMerge(input, card, e);
    case 'skip': return applySkip(input, card, e);
    case 'inbound_message': return applyInboundMessage(input, card, e);
    case 'inbound_reactivate': return applyInboundReactivate(input, card, e);
    case 'agreed_sweep': return applyAgreedSweep(input, card, e);
    case 'import_agreed': return applyImportAgreed(input, card, e);
    case 'attendance_corrected': return applyAttendanceCorrected(input, card, e);
    case 'enter':
    case 'outcome':
      return reject('invalid_transition');
  }
}

export const applyOutcome: ApplyOutcome = (input) => {
  const e = input.event;
  if (e.type === 'outcome') return applyOutcomeEvent(input, e);
  if (e.type === 'enter') return applyEnter(input, e);

  // Общий порядок остальных событий: карточка → права → версия → переход → поля и лимиты.
  const card = input.card;
  if (card === null) return reject('not_found');
  const { actor } = input;
  if (SYSTEM_ONLY.has(e.type) && actor.kind === 'user') return reject('forbidden');
  if (OWNER_ONLY.has(e.type) && actor.scope === 'own') {
    const isOwner = actor.userId !== null && (card.ownerUserId === actor.userId || card.actingUserId === actor.userId);
    if (!isOwner) return reject('not_found');
  }
  const seen = seenVersionOf(e);
  if (seen !== null && seen !== card.version) return reject('version_conflict');
  return dispatch(input, card);
};
