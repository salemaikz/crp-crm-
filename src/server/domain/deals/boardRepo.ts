// SQL досок (B8): сделки по этапам и вид «Обзвон». Строки сделок, карточек и задач — только через scopeSql
// (сделка видна по карточке клиента, `deal.read`; обзвон — `card.read`). Один проход на колонки, без запроса на плитку.
// Тексты запросов повторяют список колонок намеренно: общий фрагмент собирать из доменного кода нельзя (слои).
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

const DAY_MS = 86_400_000;

export interface DealRow {
  id: string;
  version: number;
  stageKey: string;
  status: 'open' | 'won' | 'lost';
  stageChangedAt: number;
  clientId: string;
  needsRebook: boolean;
  custom: Record<string, unknown>;
  clientName: string;
  clientCustom: Record<string, unknown>;
  ownerName: string | null;
  phone: string | null;
  contactName: string | null;
  hasBooking: boolean;
  hasAttendance: boolean;
  taskId: string | null;
  taskDueAt: number | null;
  taskTitle: string | null;
}

export interface BoardArgs {
  spaceId: string;
  pipelineKey: string;
  /** null — все сотрудники. */
  owner: string | null;
}

/** Окно по этапам: первые `limit` открытых сделок каждой колонки (давнее на этапе — выше). */
export async function selectDealWindow(viewer: Viewer, sql: Sql, a: BoardArgs & { limit: number }): Promise<DealRow[]> {
  return scoped(sql)<DealRow>`
    WITH w AS (
      SELECT d.id, row_number() OVER (PARTITION BY d.stage_key ORDER BY d.stage_changed_at, d.id) AS rn
        FROM deals d
       WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open'
         AND (${a.owner}::text IS NULL OR d.owner_user_id = ${a.owner}::text)
         AND ${scopeSql(viewer, 'deal', 'deal.read')})
    SELECT d.id, d.version, d.stage_key, d.status, d.stage_changed_at, d.client_id, d.needs_rebook, d.custom,
           cl.name AS client_name, cl.custom AS client_custom, u.name AS owner_name,
           (SELECT p.digits FROM client_phones p WHERE p.client_id = d.client_id AND p.is_working
             ORDER BY p.is_primary DESC, p.created_at, p.id LIMIT 1) AS phone,
           (SELECT ct.name FROM contacts ct WHERE ct.client_id = d.client_id AND ct.is_decision_maker AND ct.archived_at IS NULL
             ORDER BY ct.created_at, ct.id LIMIT 1) AS contact_name,
           EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.status IN ('registered','confirmed','attended','no_show')) AS has_booking,
           EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.status = 'attended') AS has_attendance,
           tk.id AS task_id, tk.due_at AS task_due_at, tk.title AS task_title
      FROM w JOIN deals d ON d.id = w.id
      JOIN clients cl ON cl.id = d.client_id
      LEFT JOIN users u ON u.id = d.owner_user_id
      LEFT JOIN LATERAL (SELECT t.id, t.due_at, t.title FROM tasks t
                          WHERE t.deal_id = d.id AND t.status = 'open' AND ${scopeSql(viewer, 'task', 'task.read')}
                          ORDER BY t.due_at NULLS LAST, t.id LIMIT 1) tk ON TRUE
     WHERE w.rn <= ${a.limit}
     ORDER BY d.stage_key, w.rn`;
}

/** Страница «ещё» одной колонки: после ключа `(afterAt, afterId)`, на одну плитку больше лимита (признак продолжения). */
export async function selectDealColumnPage(
  viewer: Viewer,
  sql: Sql,
  a: BoardArgs & { stageKey: string; afterAt: number; afterId: string; limit: number },
): Promise<DealRow[]> {
  return scoped(sql)<DealRow>`
    SELECT d.id, d.version, d.stage_key, d.status, d.stage_changed_at, d.client_id, d.needs_rebook, d.custom,
           cl.name AS client_name, cl.custom AS client_custom, u.name AS owner_name,
           (SELECT p.digits FROM client_phones p WHERE p.client_id = d.client_id AND p.is_working
             ORDER BY p.is_primary DESC, p.created_at, p.id LIMIT 1) AS phone,
           (SELECT ct.name FROM contacts ct WHERE ct.client_id = d.client_id AND ct.is_decision_maker AND ct.archived_at IS NULL
             ORDER BY ct.created_at, ct.id LIMIT 1) AS contact_name,
           EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.status IN ('registered','confirmed','attended','no_show')) AS has_booking,
           EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.status = 'attended') AS has_attendance,
           tk.id AS task_id, tk.due_at AS task_due_at, tk.title AS task_title
      FROM deals d
      JOIN clients cl ON cl.id = d.client_id
      LEFT JOIN users u ON u.id = d.owner_user_id
      LEFT JOIN LATERAL (SELECT t.id, t.due_at, t.title FROM tasks t
                          WHERE t.deal_id = d.id AND t.status = 'open' AND ${scopeSql(viewer, 'task', 'task.read')}
                          ORDER BY t.due_at NULLS LAST, t.id LIMIT 1) tk ON TRUE
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open' AND d.stage_key = ${a.stageKey}
       AND (${a.owner}::text IS NULL OR d.owner_user_id = ${a.owner}::text)
       AND (d.stage_changed_at, d.id) > (${a.afterAt}::bigint, ${a.afterId}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     ORDER BY d.stage_changed_at, d.id
     LIMIT ${a.limit}`;
}

/** Счётчики открытых сделок по этапам (те же условия, что у окна). */
export async function countDealColumns(viewer: Viewer, sql: Sql, a: BoardArgs): Promise<{ stageKey: string; n: number }[]> {
  return scoped(sql)<{ stageKey: string; n: number }>`
    SELECT d.stage_key, count(*)::int AS n
      FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open'
       AND (${a.owner}::text IS NULL OR d.owner_user_id = ${a.owner}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     GROUP BY d.stage_key`;
}

/** Выиграно и проиграно за 30 суток. */
export async function countClosedDeals(viewer: Viewer, sql: Sql, a: BoardArgs & { now: number }): Promise<{ won: number; lost: number }> {
  const since = a.now - 30 * DAY_MS;
  const rows = await scoped(sql)<{ won: number; lost: number }>`
    SELECT (count(*) FILTER (WHERE d.status = 'won' AND d.won_at >= ${since}::bigint))::int AS won,
           (count(*) FILTER (WHERE d.status = 'lost' AND d.lost_at >= ${since}::bigint))::int AS lost
      FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status IN ('won','lost')
       AND (${a.owner}::text IS NULL OR d.owner_user_id = ${a.owner}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}`;
  return rows[0] ?? { won: 0, lost: 0 };
}

export interface ClosedRow extends DealRow {
  closedAt: number;
}

/** Закрытые сделки (выигранные и проигранные), новые первыми; страница — по ключу `(closedAt, id)` строго раньше `before`. */
export async function selectClosedDeals(viewer: Viewer, sql: Sql, a: BoardArgs & { beforeAt: number | null; beforeId: string | null; limit: number }): Promise<ClosedRow[]> {
  return scoped(sql)<ClosedRow>`
    SELECT d.id, d.version, d.stage_key, d.status, d.stage_changed_at, d.client_id, d.needs_rebook, d.custom,
           COALESCE(d.won_at, d.lost_at) AS closed_at,
           cl.name AS client_name, cl.custom AS client_custom, u.name AS owner_name,
           (SELECT p.digits FROM client_phones p WHERE p.client_id = d.client_id AND p.is_working
             ORDER BY p.is_primary DESC, p.created_at, p.id LIMIT 1) AS phone,
           (SELECT ct.name FROM contacts ct WHERE ct.client_id = d.client_id AND ct.is_decision_maker AND ct.archived_at IS NULL
             ORDER BY ct.created_at, ct.id LIMIT 1) AS contact_name,
           FALSE AS has_booking, FALSE AS has_attendance,
           NULL::text AS task_id, NULL::bigint AS task_due_at, NULL::text AS task_title
      FROM deals d
      JOIN clients cl ON cl.id = d.client_id
      LEFT JOIN users u ON u.id = d.owner_user_id
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status IN ('won','lost')
       AND (${a.owner}::text IS NULL OR d.owner_user_id = ${a.owner}::text)
       AND (${a.beforeAt}::bigint IS NULL OR (COALESCE(d.won_at, d.lost_at), d.id) < (${a.beforeAt}::bigint, ${a.beforeId}::text))
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     ORDER BY COALESCE(d.won_at, d.lost_at) DESC, d.id DESC
     LIMIT ${a.limit}`;
}

/** Сотрудники с открытыми сделками воронки — выбор «Чьи сделки». */
export async function selectDealOwners(viewer: Viewer, sql: Sql, a: { spaceId: string; pipelineKey: string }): Promise<{ userId: string; name: string }[]> {
  return scoped(sql)<{ userId: string; name: string }>`
    SELECT DISTINCT u.id AS user_id, u.name
      FROM deals d JOIN users u ON u.id = d.owner_user_id
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open'
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     ORDER BY u.name, u.id`;
}

// ---------------------------------------------------------------------------
// Вид «Обзвон»
// ---------------------------------------------------------------------------

export interface CallingRow {
  id: string;
  version: number;
  state: 'new' | 'retry' | 'callback' | 'agreed';
  clientId: string;
  clientName: string;
  workerId: string | null;
  workerName: string | null;
  attempts: number;
  nextCallAt: number | null;
  lastOutcomeCode: string;
  lastOutcomeAt: number | null;
  decisionMakerId: string | null;
}

export interface CallingArgs {
  spaceId: string;
  /** null — все сотрудники. */
  worker: string | null;
}

/**
 * Карточки одной колонки с владельцем и без задержки (пул — экран раздачи). Порядок: `new` — по выдаче,
 * `agreed` — свежие итоги первыми, остальные — по сроку перезвона.
 */
export async function selectCallingCards(viewer: Viewer, sql: Sql, a: CallingArgs & { state: string; offset: number; limit: number }): Promise<CallingRow[]> {
  return scoped(sql)<CallingRow>`
    SELECT c.id, c.version, c.state, c.client_id, cl.name AS client_name,
           COALESCE(c.acting_user_id, c.owner_user_id) AS worker_id, u.name AS worker_name,
           c.attempts, c.next_call_at, c.last_outcome_code, c.last_outcome_at,
           (SELECT ct.id FROM contacts ct WHERE ct.client_id = c.client_id AND ct.is_decision_maker AND ct.archived_at IS NULL
             ORDER BY ct.created_at, ct.id LIMIT 1) AS decision_maker_id
      FROM cards c JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users u ON u.id = COALESCE(c.acting_user_id, c.owner_user_id)
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NOT NULL AND c.hold_reason = '' AND c.state = ${a.state}
       AND (${a.worker}::text IS NULL OR COALESCE(c.acting_user_id, c.owner_user_id) = ${a.worker}::text)
       AND ${scopeSql(viewer, 'card', 'card.read')}
     ORDER BY CASE WHEN c.state = 'new' THEN c.assigned_at WHEN c.state = 'agreed' THEN -c.last_outcome_at ELSE c.next_call_at END NULLS LAST, c.id
     OFFSET ${a.offset} LIMIT ${a.limit}`;
}

export async function countCallingColumns(viewer: Viewer, sql: Sql, a: CallingArgs): Promise<{ state: string; n: number }[]> {
  return scoped(sql)<{ state: string; n: number }>`
    SELECT c.state, count(*)::int AS n
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NOT NULL AND c.hold_reason = '' AND c.state IN ('new','retry','callback','agreed')
       AND (${a.worker}::text IS NULL OR COALESCE(c.acting_user_id, c.owner_user_id) = ${a.worker}::text)
       AND ${scopeSql(viewer, 'card', 'card.read')}
     GROUP BY c.state`;
}

/** Плитка «Закрыто»: закрытые за 30 суток по состояниям, уходящим из обзвона. */
export async function countCallingClosed(viewer: Viewer, sql: Sql, a: CallingArgs & { now: number }): Promise<number> {
  const since = a.now - 30 * DAY_MS;
  const rows = await scoped(sql)<{ n: number }>`
    SELECT count(*)::int AS n
      FROM cards c
     WHERE c.space_id = ${a.spaceId}
       AND c.state IN ('not_interested','not_target','do_not_call','written_off','client') AND c.closed_at >= ${since}::bigint
       AND (${a.worker}::text IS NULL OR COALESCE(c.acting_user_id, c.owner_user_id) = ${a.worker}::text)
       AND ${scopeSql(viewer, 'card', 'card.read')}`;
  return rows[0]?.n ?? 0;
}

/** Сотрудники, у которых сейчас есть карточки в обзвоне — выбор «Чьи карточки». */
export async function selectCallingWorkers(viewer: Viewer, sql: Sql, a: { spaceId: string }): Promise<{ userId: string; name: string }[]> {
  return scoped(sql)<{ userId: string; name: string }>`
    SELECT DISTINCT u.id AS user_id, u.name
      FROM cards c JOIN users u ON u.id = COALESCE(c.acting_user_id, c.owner_user_id)
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NOT NULL AND c.hold_reason = '' AND c.state IN ('new','retry','callback','agreed')
       AND ${scopeSql(viewer, 'card', 'card.read')}
     ORDER BY u.name, u.id`;
}

export interface PhoneRow {
  id: string;
  clientId: string;
  digits: string;
}

/** Рабочие номера клиентов (для закрытых номеров шторки; цифры наружу не идут). Клиенты уже отобраны с охватом. */
export async function selectWorkingPhones(viewer: Viewer, sql: Sql, clientIds: readonly string[]): Promise<PhoneRow[]> {
  if (clientIds.length === 0) return [];
  return scoped(sql)<PhoneRow>`
    SELECT cp.id, cp.client_id, cp.digits
      FROM client_phones cp
     WHERE cp.client_id = ANY(${[...clientIds]}) AND cp.is_working AND ${scopeSql(viewer, 'client_phone', 'client.read')}
     ORDER BY cp.client_id, cp.is_primary DESC, cp.created_at, cp.id`;
}
