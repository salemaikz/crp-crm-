// Сделки: в B2 — связка с записью и исполнитель эффектов машины карточки. Доски — B8. Остальное — B6.
export { applyDealEffects, createDealLink, dealLink } from './effects';
export { bookingPipeline, parsePipelines, toDealStages, type PipelineInfo, type PipelineResolver, type PipelineStage } from './pipelines';
export { getCallingBoard, getCallingColumn, getClosedDeals, getDealsBoard, getDealsColumn } from './board';
export { boardDeps, overrideBoardDepsForTests, parseBoardPipelines, type BoardDeps } from './boardDeps';
export { missingFor, staleDaysOf } from './boardRules';
export * from './boardTypes';
