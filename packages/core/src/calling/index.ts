// Обзвон: машина состояний карточки (K1d).
export { applyOutcome } from './applyOutcome.js';
export { parseCallbackStep, resolveCallbackDue, stepForTouch } from './callbackSchedule.js';
export { dueBounds, fireOf, isOverdue } from './due.js';
export type { CallbackDue, CallbackStep } from './callbackSchedule.js';
export type { DueBounds } from './due.js';
export { HEAT_MAX, compareForQueue, heatOf } from './heat.js';
export type { HeatCard, HeatWeights, QueueKey } from './heat.js';
export { AGREED_EXIT_READY, COLUMN_BOOKING_STATUSES, columnOf, dropActions, isRecentlyClosed } from './board.js';
export type { BoardCard, BoardColumnDef, BoardSpec, DealBooking, DropActionKind, DropActor, DropBlocked, DropTarget } from './board.js';
export { writeOffEffects } from './transitionKit.js';
export type * from './spec/types.js';
export {
  CARD_STATES,
  OUTCOME_KINDS,
  WORKING_STATES,
  CONNECTED_KINDS,
  OUTCOME_ALLOWED_FROM,
  LPR_ON_CONTACT_KINDS,
  CALLBACK_TASK_SOURCES,
  OCCURRED_FUTURE_TOLERANCE_MS,
} from './spec/types.js';
