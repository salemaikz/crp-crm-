// Сделки: связка с записью и исполнитель эффектов машины карточки (B2), покупка, её правка и отмена, этап,
// проигрыш, страница сделки и форма покупки (B6). Репозитории наружу не выходят.
export { applyDealEffects, createDealLink, dealLink } from './effects';
export { bookingPipeline, parsePipelines, toDealStages, type PipelineInfo, type PipelineResolver, type PipelineStage } from './pipelines';
export { checkAmount, isForward, lostStageOf, purchaseMoment, stageRequirements, staleDaysOf, wonStageOf } from './rules';
export { countStaleDeals } from './stale';
export { dealsDeps, overrideDealsDepsForTests } from './deps';
export { CardRejectedError, DealDomainError, DEAL_HTTP_STATUS, isDealDomainError } from './errors';
export { loadDealsSettings, parseDealsSettings } from './settings';
export { cancelPurchase, editPurchase, registerPurchase, type EditPurchaseRequest } from './purchase';
export { loseDeal, moveDealStage } from './stage';
export { getDealPage, getPurchaseForm, toDealView } from './read';
export * from './types';
