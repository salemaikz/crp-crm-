// Отчёты: сводка дня РОП (R1a). Репозиторий (repo.ts) наружу не выходит.
export { overrideReportsDepsForTests, reportsDeps } from './deps';
export { getSummary } from './summary';
export { parseReportsSlice } from './settings';
export { buildOperatorRows, callsPerHour, isBelowTarget, operatorStatus, roomToday } from './compose';
export * from './types';
