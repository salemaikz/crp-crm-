// Отчёты: сводка дня РОП (R1a). Репозиторий (repo.ts) наружу не выходит.
export { overrideReportsDepsForTests, reportsDeps } from './deps';
export { getSummary } from './summary';
export { parseReportsSlice } from './settings';
export { buildOperatorRows, callsPerHour, isBelowTarget, operatorStatus, roomToday } from './compose';
export * from './types';

// Отчёты за период (R3a)
export { getDefaultPeriod, getReport } from './get';
export { parseReportQuery } from './query';
export { getReportMeta, type ReportLabels, type ReportMeta } from './meta';
export { bucketOf, defaultPeriod, previousWeek, resolvePeriod, weekOf } from './period';
export { rate } from './definitions';
export * from './reportTypes';

// Выгрузки, журнал и полная выгрузка (R3b)
export { exportTranslator, labelKey, toExportTable, type ExportLabels } from './exportTable';
export { canSeeExportJournal, exportMeta, FILTER_KEYS, getExportJournal, JOURNAL_PAGE, writeExportLog, writeExportLogIn } from './exportLog';
export { ExportLimitError, ExportTooLargeError, PasswordInvalidError, type ExportLimitCode } from './exportErrors';
export { FULL_EXPORTS_PER_DAY, issueFullExportTicket, streamFullExport } from './fullExport';
