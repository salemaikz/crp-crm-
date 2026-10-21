// SQL журнала выгрузок (R3b §2.4, PROCESS 8.6): строки audit_log `export.*` по индексу audit_log_action_idx. Журнал —
// служебная таблица без данных клиентов: в meta только коды и числа (writeExportLog), имя — только у сотрудника.
import type { Sql } from '@/server/platform/db';

export const EXPORT_ACTIONS = ['export.report', 'export.full', 'export.guests'] as const;

export interface JournalDbRow {
  id: string;
  at: number;
  actorId: string | null;
  actorName: string | null;
  action: string;
  meta: unknown;
}

/** Страница журнала: администратор — вся установка, иначе — своё пространство. На 1 строку больше лимита. */
export async function selectExportJournal(
  sql: Sql,
  a: { allSpaces: boolean; spaceId: string | null; before: { at: number; id: string } | null; limit: number },
): Promise<JournalDbRow[]> {
  const beforeAt = a.before?.at ?? null;
  const beforeId = a.before?.id ?? null;
  return sql<JournalDbRow>`
    SELECT a.id, a.created_at AS at, a.actor_id, u.name AS actor_name, a.action, a.meta
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.action = ANY(${[...EXPORT_ACTIONS]}::text[])
       AND (${a.allSpaces}::boolean OR a.space_id = ${a.spaceId}::text)
       AND (${beforeAt}::bigint IS NULL OR (a.created_at, a.id) < (${beforeAt}::bigint, ${beforeId}::text))
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${a.limit + 1}`;
}

/** Отметка завершения полной выгрузки (D-294): служебная строка, в журнал выгрузок не попадает. */
export const FULL_EXPORT_DONE = 'export.full_done';

export interface FullExportCounts {
  /** Начатых: журнал пишется до первого байта (D-264). */
  started: number;
  /** Завершённых: архив дописан до конца (D-294). */
  completed: number;
}

/** Полные выгрузки сотрудника с момента `since` (начало местных суток): лимиты в сутки (D-264, D-294). */
export async function countFullExportsSince(sql: Sql, a: { userId: string; since: number }): Promise<FullExportCounts> {
  const rows = await sql<FullExportCounts>`
    SELECT count(*) FILTER (WHERE action = 'export.full')::int AS started,
           count(*) FILTER (WHERE action = ${FULL_EXPORT_DONE})::int AS completed
      FROM audit_log
     WHERE action IN ('export.full', ${FULL_EXPORT_DONE}) AND actor_id = ${a.userId} AND created_at >= ${a.since}::bigint`;
  return rows[0] ?? { started: 0, completed: 0 };
}
