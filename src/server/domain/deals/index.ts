// Сделки: в B2 — связка с записью и исполнитель эффектов машины карточки. Остальное — B6.
export { applyDealEffects, createDealLink, dealLink } from './effects';
export { bookingPipeline, parsePipelines, toDealStages, type PipelineInfo, type PipelineResolver, type PipelineStage } from './pipelines';
