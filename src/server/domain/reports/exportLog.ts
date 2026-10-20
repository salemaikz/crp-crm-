// Журнал выгрузок (R3b §2.4, PROCESS 8.6): запись — строка audit_log `export.*` до отдачи тела; чтение — администратор
// или разрешение `export.journal` (директор). В meta — только белый список ключей; фильтры — именами, без значений.
import { ForbiddenError, can, type Viewer } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { selectExportJournal } from './exportRepo';
import { REPORT_KEYS, type ExportJournalRow, type ExportLogInput, type GetExportJournal, type WriteExportLog } from './reportTypes';

/** Имена параметров фильтра и группировки, которые попадают в журнал (значения — никогда). */
export const FILTER_KEYS = ['users', 'source', 'group', 'by'] as const;
const FILTER_SET: ReadonlySet<string> = new Set(FILTER_KEYS);
const FORMATS: ReadonlySet<string> = new Set(['csv', 'xlsx', 'zip']);
const KINDS: ReadonlySet<string> = new Set(['report', 'full', 'guests']);
const ACTION = { report: 'export.report', full: 'export.full', guests: 'export.guests' } as const;

export const JOURNAL_PAGE = 50;

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0);

/** meta записи: ровно эти ключи; лишнее в input отбрасывается, а не пишется. */
export function exportMeta(input: ExportLogInput): Record<string, unknown> {
  return {
    kind: input.kind,
    reportKey: input.reportKey !== null && (REPORT_KEYS as readonly string[]).includes(input.reportKey) ? input.reportKey : null,
    format: input.format,
    rows: count(input.rows),
    filterKeys: [...new Set(input.filterKeys.filter((k) => FILTER_SET.has(k)))].sort(),
    periodDays: input.periodDays === null ? null : count(input.periodDays),
  };
}

/** Запись журнала в транзакции вызывающего (полная выгрузка пишет журнал вместе с уведомлениями). */
export async function writeExportLogIn(sql: Sql, viewer: Viewer, input: ExportLogInput): Promise<void> {
  if (!KINDS.has(input.kind) || !FORMATS.has(input.format)) throw new Error('writeExportLog: неизвестный вид или формат');
  await writeAudit(sql, {
    actorId: viewer.userId,
    action: ACTION[input.kind],
    entity: 'export',
    entityId: viewer.userId,
    spaceId: viewer.spaceId,
    meta: exportMeta(input),
    createdAt: viewer.now,
  });
}

/** Запись журнала до отдачи тела выгрузки (журнал остаётся, даже если скачивание оборвали). */
export const writeExportLog: WriteExportLog = async (viewer, input) => writeExportLogIn((await getDb()).sql, viewer, input);

/** Журнал виден администратору и разрешению `export.journal`; остальным — 403 раздела. */
export function canSeeExportJournal(viewer: Viewer): boolean {
  return viewer.isAdmin || (viewer.spaceId !== null && can(viewer, 'export.journal'));
}

function rowOf(r: { id: string; at: number; actorId: string | null; actorName: string | null; action: string; meta: unknown }): ExportJournalRow {
  const m = (typeof r.meta === 'object' && r.meta !== null ? r.meta : {}) as Record<string, unknown>;
  const kindFromAction = r.action.slice('export.'.length);
  const kind = (KINDS.has(kindFromAction) ? kindFromAction : 'report') as ExportJournalRow['kind'];
  return {
    id: r.id,
    at: r.at,
    actorUserId: r.actorId,
    actorName: r.actorName,
    kind,
    reportKey: typeof m.reportKey === 'string' && (REPORT_KEYS as readonly string[]).includes(m.reportKey) ? m.reportKey : null,
    format: typeof m.format === 'string' && FORMATS.has(m.format) ? m.format : '',
    rows: count(m.rows),
    filterKeys: Array.isArray(m.filterKeys) ? m.filterKeys.filter((k): k is string => typeof k === 'string' && FILTER_SET.has(k)) : [],
    periodDays: m.periodDays === null || m.periodDays === undefined ? null : count(m.periodDays),
  };
}

export const getExportJournal: GetExportJournal = async (viewer, q) => {
  if (!canSeeExportJournal(viewer)) throw new ForbiddenError();
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), JOURNAL_PAGE);
  const db = await getDb();
  const rows = await selectExportJournal(db.sql, { allSpaces: viewer.isAdmin, spaceId: viewer.spaceId, before: q.before, limit });
  const page = rows.slice(0, limit).map(rowOf);
  const last = page[page.length - 1];
  return { rows: page, next: rows.length > limit && last ? { at: last.at, id: last.id } : null };
};
