// Сделки: связка с записью и исполнитель эффектов машины карточки (B2), покупка, её правка и отмена, этап,
// проигрыш, страница сделки и форма покупки (B6), доски «Сделки» и «Обзвон» (B8). Репозитории наружу не выходят.
export { applyDealEffects, createDealLink, dealLink } from './effects';
export { bookingPipeline, parsePipelines, toDealStages, type PipelineInfo, type PipelineResolver, type PipelineStage } from './pipelines';
export { checkAmount, isForward, lostStageOf, purchaseMoment, stageFieldLabels, stageRequirements, staleDaysOf, wonStageOf } from './rules';
export { countStaleDeals } from './stale';
export { dealsDeps, overrideDealsDepsForTests } from './deps';
export { CardRejectedError, DealDomainError, DEAL_HTTP_STATUS, isDealDomainError } from './errors';
export { loadDealsSettings, parseDealsSettings } from './settings';
export { stageFieldLabelsFor } from './fieldLabels';
export { cancelPurchase, editPurchase, registerPurchase, type EditPurchaseRequest } from './purchase';
export { loseDeal, moveDealStage } from './stage';
export { getDealPage, getPurchaseForm, toDealView } from './read';
export { getCallingBoard, getCallingColumn, getClosedDeals, getDealsBoard, getDealsColumn } from './board';
export { boardDeps, overrideBoardDepsForTests, parseBoardPipelines, type BoardDeps } from './boardDeps';
export { missingFor } from './boardRules';
export * from './boardTypes';
export * from './types';
