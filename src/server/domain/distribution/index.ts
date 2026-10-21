// Раздача: пул, участники, автотик, ручная выдача, журнал. Репозиторий (repo.ts) наружу не выходит.
export { distributionDeps, overrideDistributionDepsForTests } from './deps';
export { DistributionDomainError, DISTRIBUTION_HTTP_STATUS, failureBody, isDistributionDomainError } from './errors';
export { applyAbsences, cancelAbsence, createAbsence, listAbsences, MAX_ABSENCE_DAYS, runAbsences } from './absence';
export { absenceJob, distributeJob, distributeSchedule } from './job';
export { getJournal, MAX_JOURNAL_DAYS } from './journal';
export { issueCards } from './manual';
export { assignOwnerless, listOwnerless } from './ownerless';
export { listParticipants, participantStatus, setParticipation, setPause } from './participants';
export { getPool } from './pool';
export { listProposals, resolveProposal, type ProposalView, type ResolveProposalInput, type ResolveProposalResult } from './proposals';
export { loadDistributionConfig, parseDistributionConfig } from './settings';
export { runTick } from './tick';
export * from './types';
export { listPairs, PAIRS_LIMIT, resolvePair, type PairPhoneView, type PairSideView, type PairView, type PairsPage, type ResolvePairInput, type ResolvePairResult } from './pairs';
export type { PairReason, PairStatus } from './pairsRepo';
