// SQL обзвона вне карточки (docs/calls-design.md §7, §8, §10): пропуски, очередь «Звонить», статус устройства.
// Строки карточки в очереди выбираются через scopeSql.
import type { calling } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import type { QueueGroup } from '@/server/domain/cards/types';
import { SKIP_LOCK_CLASS } from './types';

// ---------------------------------------------------------------------------
// Пропуски
// ---------------------------------------------------------------------------

/** Блокировка пропусков сотрудника: берётся ДО карточки, итог её не берёт — цикла нет (§7). */
export async function lockUserSkips(tx: Sql, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${SKIP_LOCK_CLASS}::int, hashtext(${userId}))`;
}

export async function findPriorSkip(tx: Sql, opId: string): Promise<{ userId: string; cardId: string } | null> {
  const rows = await tx<{ userId: string; cardId: string }>`SELECT user_id, card_id FROM skips WHERE id = ${opId}`;
  return rows[0] ?? null;
}

export async function countSkipsToday(tx: Sql, userId: string, day: string): Promise<number> {
  const rows = await tx<{ n: number }>`SELECT count(*)::int AS n FROM skips WHERE user_id = ${userId} AND day = ${day}`;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Очередь
// ---------------------------------------------------------------------------

export interface QueueCardRow {
  id: string;
  clientId: string;
  state: calling.CardState;
  version: number;
  attempts: number;
  nextCallAt: number | null;
  lastOutcomeCode: string;
  lastOutcomeAt: number | null;
  lpr: calling.Lpr;
  isTarget: calling.Target;
  custom: Record<string, unknown>;
  skippedAt: number | null;
}

export interface QueueSelect {
  spaceId: string;
  userId: string;
  now: number;
  today: string;
  order: readonly QueueGroup[];
  mobileFirst: boolean;
  group: QueueGroup | 'all';
  exclude: readonly string[];
  limit: number;
}

/** Группа очереди по состоянию (`returns` до C6c пуста: возврат делает карточку `callback`). */
export const groupOfState = (state: string): QueueGroup => (state === 'callback' ? 'callbacks' : state === 'retry' ? 'retries' : 'new');

/** Отобранные карточки очереди по порядку групп (D-177). */
export async function selectQueue(sql: Sql, viewer: Viewer, q: QueueSelect): Promise<QueueCardRow[]> {
  const groupState = q.group === 'all' ? null : q.group === 'callbacks' ? 'callback' : q.group === 'retries' ? 'retry' : q.group === 'new' ? 'new' : '-';
  return scoped(sql)<QueueCardRow>`
    WITH mine AS (
      SELECT c.id, c.client_id, c.state, c.version, c.attempts, c.next_call_at, c.assigned_at, c.created_at,
             c.last_outcome_code, c.last_outcome_at, c.lpr, c.is_target, c.custom
        FROM cards c
       WHERE c.space_id = ${q.spaceId} AND (c.owner_user_id = ${q.userId} OR c.acting_user_id = ${q.userId})
         AND c.hold_reason = '' AND c.state IN ('new','retry','callback')
         AND (c.state = 'new' OR c.next_call_at <= ${q.now})
         AND NOT (c.id = ANY(${[...q.exclude]}::text[]))
         AND (${groupState}::text IS NULL OR c.state = ${groupState}::text)
         AND ${scopeSql(viewer, 'card', 'card.outcome')}),
    skipped AS (SELECT card_id, max(created_at) AS at FROM skips WHERE user_id = ${q.userId} AND day = ${q.today} GROUP BY card_id)
    SELECT m.id, m.client_id, m.state, m.version, m.attempts, m.next_call_at, m.last_outcome_code, m.last_outcome_at, m.lpr, m.is_target,
           m.custom, s.at AS skipped_at,
           (m.state = 'new' AND EXISTS (SELECT 1 FROM client_phones p
              WHERE p.client_id = m.client_id AND p.is_working AND p.kind = 'mobile')) AS has_mobile
      FROM mine m LEFT JOIN skipped s ON s.card_id = m.id
     ORDER BY (s.at IS NOT NULL), s.at,
              array_position(${[...q.order]}::text[], CASE m.state WHEN 'callback' THEN 'callbacks' WHEN 'retry' THEN 'retries' ELSE 'new' END),
              m.next_call_at NULLS LAST,
              (CASE WHEN ${q.mobileFirst} THEN (m.state = 'new' AND EXISTS (SELECT 1 FROM client_phones p
                  WHERE p.client_id = m.client_id AND p.is_working AND p.kind = 'mobile')) ELSE FALSE END) DESC,
              m.assigned_at NULLS LAST, m.created_at, m.id
     LIMIT ${q.limit}`;
}

export interface QueueCountsRow {
  callbacks: number;
  retries: number;
  new: number;
  overdue: number;
}

/** Счётчики по тому же `mine` без `LIMIT`, `exclude` и вкладки. */
export async function countQueue(sql: Sql, viewer: Viewer, q: { spaceId: string; userId: string; now: number; overdueBefore: number }): Promise<QueueCountsRow> {
  const rows = await scoped(sql)<QueueCountsRow>`
    SELECT count(*) FILTER (WHERE c.state = 'callback')::int AS callbacks,
           count(*) FILTER (WHERE c.state = 'retry')::int AS retries,
           count(*) FILTER (WHERE c.state = 'new')::int AS new,
           count(*) FILTER (WHERE c.state = 'callback' AND c.next_call_at < ${q.overdueBefore})::int AS overdue
      FROM cards c
     WHERE c.space_id = ${q.spaceId} AND (c.owner_user_id = ${q.userId} OR c.acting_user_id = ${q.userId})
       AND c.hold_reason = '' AND c.state IN ('new','retry','callback')
       AND (c.state = 'new' OR c.next_call_at <= ${q.now})
       AND ${scopeSql(viewer, 'card', 'card.outcome')}`;
  return rows[0] ?? { callbacks: 0, retries: 0, new: 0, overdue: 0 };
}

export interface QueuePhoneRow {
  id: string;
  clientId: string;
  digits: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isPrimary: boolean;
}

/** Рабочие номера отобранных карточек, не из стоп-листа (по HMAC); цифры полностью — для `tel:` своей карточки. */
export async function queuePhones(sql: Sql, clientIds: readonly string[]): Promise<QueuePhoneRow[]> {
  if (clientIds.length === 0) return [];
  const rows = await sql<QueuePhoneRow>`
    SELECT p.id, p.client_id, p.digits, p.kind, p.is_primary FROM client_phones p
     WHERE p.client_id = ANY(${[...clientIds]}) AND p.is_working
     ORDER BY p.client_id, p.is_primary DESC, (p.kind = 'mobile') DESC, p.created_at, p.id`;
  if (rows.length === 0) return [];
  const hmacs = rows.map((r) => phoneHmac(r.digits));
  const stopped = await sql<{ phoneHmac: string }>`SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY(${hmacs})`;
  const bad = new Set(stopped.map((s) => s.phoneHmac));
  return rows.filter((_, i) => !bad.has(hmacs[i]!));
}

export interface QueueClientRow {
  id: string;
  name: string;
  custom: Record<string, unknown>;
}

export async function queueClients(sql: Sql, clientIds: readonly string[]): Promise<QueueClientRow[]> {
  if (clientIds.length === 0) return [];
  return sql<QueueClientRow>`SELECT id, name, custom FROM clients WHERE id = ANY(${[...clientIds]})`;
}

// ---------------------------------------------------------------------------
// Устройство (D-063, D-178)
// ---------------------------------------------------------------------------

/** Старый запрос не перетирает новый (`seen_at` не убывает). */
export async function upsertDeviceStatus(sql: Sql, a: { userId: string; deviceId: string; pending: number; lastFlushAt: number | null; now: number }): Promise<void> {
  await sql`
    INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at)
    VALUES (${a.userId}, ${a.deviceId}, ${a.pending}, ${a.lastFlushAt}, ${a.now})
    ON CONFLICT (user_id, device_id) DO UPDATE
       SET pending_outbox = EXCLUDED.pending_outbox,
           last_flush_at = COALESCE(EXCLUDED.last_flush_at, device_status.last_flush_at),
           seen_at = EXCLUDED.seen_at
     WHERE device_status.seen_at <= EXCLUDED.seen_at`;
}

export async function deleteDeviceStatusBefore(sql: Sql, before: number): Promise<number> {
  const rows = await sql<{ userId: string }>`DELETE FROM device_status WHERE seen_at < ${before} RETURNING user_id`;
  return rows.length;
}
