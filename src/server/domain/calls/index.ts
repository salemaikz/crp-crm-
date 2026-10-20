// Итоги звонков, пропуски, очередь «Звонить» и статус устройства (C5). Репозиторий (repo.ts) наружу не выходит.
export { callsDeps, overrideCallsDepsForTests } from './deps';
export { parseDeviceHeaders, purgeDeviceStatus, recordDeviceStatus } from './device';
export { CallsDomainError, httpFailure, isCallsDomainError, type CallsHttpFailure } from './errors';
export { submitOutcome } from './outcomes';
export { getQueue } from './queue';
export { submitSkip } from './skips';
export * from './types';
