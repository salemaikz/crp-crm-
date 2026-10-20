// Карточка обзвона на сервере: настройки, исполнитель эффектов, запись перехода, порт для записи.
export { toCoreActor } from './actor';
export { applyCardEffects, resolveLead } from './effects';
export { CardActionError, isCardActionError } from './errors';
export { applyCardEventLocked, runCardEvent } from './manual';
export { countOwnerlessWorkingCards } from './invariants';
export { cardBookingPort, createCardBookingPort } from './bookingPort';
export { persistTransition } from './persist';
export { loadCallingContext, parseCallingContext } from './settings';
export * from './types';
export { archiveReasonLabels, clearDnc, closeCard, closeReasonOptions, reopenCard, type ReasonOption, type ClearDncInput, type CloseInput, type MenuResult, type ReopenInput } from './menu';
