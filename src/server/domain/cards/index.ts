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
export { moveCard, type MoveInput, type MoveTarget } from './move';
export { archiveReasonLabels, clearDnc, closeCard, closeReasonOptions, reopenCard, reopenRecipients, type ReasonOption, type ClearDncInput, type CloseInput, type MenuResult, type ReopenInput } from './menu';
export { BOARD_PAGE, BOARD_SEARCH_LIMIT, getBoard, getBoardColumn, type BoardCardDto, type BoardColumnDto, type BoardColumnPage, type BoardDto, type BoardQuery, type BoardColumnQuery } from './board';
export { derivedOf, refreshCardDerived, refreshClientDerived } from './derived';
export { HEAT_BATCH, heatRecomputeJob, recomputeSpaceHeat, type HeatRecomputeResult } from './heatJob';
