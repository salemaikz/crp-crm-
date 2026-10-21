// Итоги звонков, пропуски, очередь «Звонить» и статус устройства (C5). Репозиторий (repo.ts) наружу не выходит.
export { callsDeps, overrideCallsDepsForTests } from './deps';
export { parseDeviceHeaders, purgeDeviceStatus, recordDeviceStatus } from './device';
export {
  EXPIRED_CHECK_AFTER_MS,
  EXPIRED_REPORT_LIMITS,
  lossStatus,
  lossVerdict,
  reportExpiredOutbox,
  verifyExpiredLosses,
  type ExpiredLoss,
  type ExpiredReason,
  type ExpiredReport,
  type ExpiredResult,
  type LossStatus,
  type LossVerdict,
} from './expired';
export { CallsDomainError, httpFailure, isCallsDomainError, type CallsHttpFailure } from './errors';
export { submitOutcome } from './outcomes';
export { getQueue } from './queue';
export { submitSkip } from './skips';
export { getToday } from './today';
export * from './types';
