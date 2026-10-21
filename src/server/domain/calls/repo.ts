// SQL обзвона вне карточки (docs/calls-design.md §7, §8, §10): пропуски, очередь «Звонить», статус устройства.
// Строки карточки в очереди выбираются через scopeSql.
import type { calling } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import type { QueueGroup } from '@/server/domain/cards/types';
import { EXPIRED_CLAIM_LOCK_CLASS, SKIP_LOCK_CLASS } from '@/server/platform/db/locks';

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
  contactId: string | null;
  digits: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isPrimary: boolean;
}

/** Рабочие номера отобранных карточек, не из стоп-листа (по HMAC); цифры полностью — для `tel:` своей карточки. */
export async function queuePhones(sql: Sql, clientIds: readonly string[]): Promise<QueuePhoneRow[]> {
  if (clientIds.length === 0) return [];
  const rows = await sql<QueuePhoneRow>`
    SELECT p.id, p.client_id, p.contact_id, p.digits, p.kind, p.is_primary FROM client_phones p
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

// Проверки сообщения о потере итогов (D-308). Ответ клиенту их не раскрывает: сервер отвечает `{ ok: true }` или 404 об
// авторе, поэтому чтения идут без охвата — они решают только, что писать в журнал.

/** Сотрудник установки с таким id есть (отключённый тоже: его итоги могли остаться на телефоне). */
export async function userExists(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`SELECT id FROM users WHERE id = ${id}`;
  return rows.length > 0;
}

/** Какие из opId уже записаны звонками (id звонка = opId устройства, D-019): они дошли и не потеряны. */
export async function receivedCallIds(sql: Sql, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string }>`SELECT id FROM calls WHERE id = ANY(${[...ids]}::text[])`;
  return rows.map((r) => r.id);
}

/**
 * Ключ идемпотентности журнала потерь (D-311): сообщения об итогах одного автора записываются по очереди (блокировка
 * транзакции по автору), поэтому две вкладки или повтор после потерянного ответа не пишут строку дважды.
 */
export async function lockExpiredClaims(sql: Sql, authorId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${EXPIRED_CLAIM_LOCK_CLASS}::int, hashtext(${authorId}))`;
}

/** Какие из opId автора уже записаны в журнал потерь (любым сотрудником): второй раз они не пишутся. */
export async function claimedExpiredOpIds(sql: Sql, authorId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ op: string }>`
    SELECT DISTINCT op
      FROM audit_log a, jsonb_array_elements_text(COALESCE(a.meta->'claimed'->'opIds', '[]'::jsonb)) AS op
     WHERE a.action = 'user.outbox_expired' AND a.entity = 'user' AND a.entity_id = ${authorId}
       AND op = ANY(${[...ids]}::text[])`;
  return rows.map((r) => r.op);
}

export interface ExpiredClaimRow {
  id: string;
  actorId: string | null;
  authorId: string;
  createdAt: number;
  meta: Record<string, unknown>;
}

/** Записи журнала потерь с момента `since` (служебная проверка, D-311). Без охвата: только id, числа и opId. */
export async function expiredClaimsSince(sql: Sql, since: number): Promise<ExpiredClaimRow[]> {
  const rows = await sql<ExpiredClaimRow>`
    SELECT id, actor_id, entity_id AS author_id, created_at, meta
      FROM audit_log
     WHERE action = 'user.outbox_expired' AND entity = 'user' AND created_at >= ${since}
     ORDER BY created_at, id`;
  return rows.map((r) => ({ id: r.id, actorId: r.actorId, authorId: r.authorId, createdAt: Number(r.createdAt), meta: r.meta ?? {} }));
}

/** Сколько неотправленных итогов сотрудник сообщал с этого устройства в последний раз; null — устройство не видели. */
export async function devicePendingOf(sql: Sql, userId: string, deviceId: string): Promise<number | null> {
  const rows = await sql<{ pendingOutbox: number }>`SELECT pending_outbox FROM device_status WHERE user_id = ${userId} AND device_id = ${deviceId}`;
  return rows[0]?.pendingOutbox ?? null;
}

export async function deleteDeviceStatusBefore(sql: Sql, before: number): Promise<number> {
  const rows = await sql<{ userId: string }>`DELETE FROM device_status WHERE seen_at < ${before} RETURNING user_id`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// ЛПР и последняя заметка отобранных карточек: по одному запросу на все карточки страницы (без N+1)
// ---------------------------------------------------------------------------

export interface QueueLprRow {
  id: string;
  clientId: string;
  name: string;
  position: string;
}

/** Первый (по дате создания) не архивный ЛПР каждого клиента. */
export async function queueLprs(sql: Sql, clientIds: readonly string[]): Promise<QueueLprRow[]> {
  if (clientIds.length === 0) return [];
  return sql<QueueLprRow>`
    SELECT DISTINCT ON (ct.client_id) ct.id, ct.client_id, ct.name, ct.position
      FROM contacts ct
     WHERE ct.client_id = ANY(${[...clientIds]}) AND ct.is_decision_maker AND ct.archived_at IS NULL
     ORDER BY ct.client_id, ct.created_at, ct.id`;
}

export interface QueueNoteRow {
  clientId: string;
  text: string;
  at: number;
}

export const QUEUE_NOTE_MAX = 300;

/** Свежайшая из заметок клиента и заметок итогов звонков (пустые не считаются). */
export async function queueLastNotes(sql: Sql, spaceId: string, clientIds: readonly string[]): Promise<QueueNoteRow[]> {
  if (clientIds.length === 0) return [];
  return sql<QueueNoteRow>`
    SELECT DISTINCT ON (x.client_id) x.client_id, left(x.text, ${QUEUE_NOTE_MAX}::int) AS text, x.at
      FROM (
        SELECT n.client_id, n.body AS text, n.created_at AS at
          FROM notes n WHERE n.space_id = ${spaceId} AND n.client_id = ANY(${[...clientIds]}) AND btrim(n.body) <> ''
        UNION ALL
        SELECT c.client_id, c.note AS text, c.occurred_at AS at
          FROM calls c WHERE c.space_id = ${spaceId} AND c.client_id = ANY(${[...clientIds]}) AND btrim(c.note) <> ''
      ) x
     ORDER BY x.client_id, x.at DESC`;
}

// ---------------------------------------------------------------------------
// Сводка «Сегодня»
// ---------------------------------------------------------------------------

export interface TodayCounts {
  outcomes: number;
  connected: number;
  booked: number;
}

/** Итоги (индекс calls_stats_idx) и созданные записи сотрудника за [from, to). */
export async function selectTodayCounts(sql: Sql, a: { spaceId: string; userId: string; from: number; to: number; connectedKinds: readonly string[] }): Promise<TodayCounts> {
  const calls = await sql<{ outcomes: number; connected: number }>`
    SELECT count(*)::int AS outcomes,
           (count(*) FILTER (WHERE outcome_kind = ANY(${[...a.connectedKinds]}::text[])))::int AS connected
      FROM calls
     WHERE space_id = ${a.spaceId} AND user_id = ${a.userId} AND via <> 'import'
       AND occurred_at >= ${a.from}::bigint AND occurred_at < ${a.to}::bigint`;
  const bookings = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings
     WHERE space_id = ${a.spaceId} AND booked_by_user_id = ${a.userId}
       AND created_at >= ${a.from}::bigint AND created_at < ${a.to}::bigint
       AND status NOT IN ('cancelled','moved')`;
  return { outcomes: calls[0]?.outcomes ?? 0, connected: calls[0]?.connected ?? 0, booked: bookings[0]?.n ?? 0 };
}
