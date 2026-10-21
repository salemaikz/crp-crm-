// SQL консультаций (B5b/B5c, docs/deals-handoffs-design.md §4): снимок дня, график и исключения, назначение, резерв,
// автоназначение «серых», «Мои консультации», итог встречи. Отдельный файл рядом с repo.ts, чтобы тот не рос
// дальше 1100 строк; правила те же: первый аргумент — исполнитель или соединение, строки клиентов — через scopeSql.
// Снимок дня и график — данные пространства, не клиентов (D-245): читаются без охвата, после блокировки дня.
import { booking } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import { CONSULT_DAY_LOCK_CLASS } from '@/server/platform/db/locks';
import type { BookingRow } from './repo';

const OCCUPYING: string[] = [...booking.OCCUPYING_STATUSES];
const ACTIVE: string[] = [...booking.ACTIVE_STATUSES];

// ---------------------------------------------------------------------------
// Блокировка и снимок дня (D-245)
// ---------------------------------------------------------------------------

/** Блокировка дня консультаций пространства до конца транзакции. Порядок: карточки → день → записи (D-251). */
export async function lockConsultDayRow(sql: Sql, spaceId: string, date: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${CONSULT_DAY_LOCK_CLASS}::int, hashtext(${`${spaceId}|${date}`}))`;
}

export interface ScheduleRow {
  resourceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

export async function listScheduleOfWeekday(sql: Sql, a: { ids: readonly string[]; weekday: number }): Promise<ScheduleRow[]> {
  if (a.ids.length === 0) return [];
  return sql<ScheduleRow>`
    SELECT s.resource_id, s.weekday, s.start_time, s.end_time FROM resource_schedule s
     WHERE s.resource_id = ANY(${[...a.ids]}) AND s.weekday = ${a.weekday}
     ORDER BY s.resource_id, s.start_time`;
}

export interface ExceptionRow {
  resourceId: string;
  day: string;
  kind: booking.ExceptionKind;
  windows: unknown;
}

export async function listExceptionsOfDay(sql: Sql, a: { ids: readonly string[]; day: string }): Promise<ExceptionRow[]> {
  if (a.ids.length === 0) return [];
  return sql<ExceptionRow>`
    SELECT e.resource_id, e.day, e.kind, e.windows FROM resource_exceptions e
     WHERE e.resource_id = ANY(${[...a.ids]}) AND e.day = ${a.day}`;
}

export interface DayBookingRow {
  id: string;
  resourceId: string | null;
  startTime: string;
  durationMin: number;
  isReserve: boolean;
  createdAt: number;
  directionKey: string;
}

/** Записи дня: места консультантов (в том числе выключенных — «конфликты») и «серые» пространства. */
export async function listDayBookings(sql: Sql, a: { spaceId: string; date: string; allIds: readonly string[] }): Promise<DayBookingRow[]> {
  return sql<DayBookingRow>`
    SELECT b.id, b.resource_id, b.start_time, b.duration_min, b.is_reserve, b.created_at, b.direction_key
      FROM bookings b
     WHERE b.resource_id = ANY(${[...a.allIds]}) AND b.booking_date = ${a.date} AND b.status = ANY(${OCCUPYING})
    UNION ALL
    SELECT b.id, NULL::text, b.start_time, b.duration_min, b.is_reserve, b.created_at, b.direction_key
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.kind = 'individual' AND b.resource_id IS NULL AND b.booking_date = ${a.date}
       AND b.status = ANY(${ACTIVE})
     ORDER BY 3, 6, 1`;
}

/** Записи дня с клиентом и статусом для экрана РОП; имя — по охвату `client.read` (нет охвата — пусто). */
export interface DayDetailRow {
  id: string;
  status: booking.BookingStatus;
  version: number;
  clientName: string;
}

export async function listDayDetails(viewer: Viewer, sql: Sql, ids: readonly string[]): Promise<DayDetailRow[]> {
  if (ids.length === 0) return [];
  return scoped(sql)<DayDetailRow>`
    SELECT b.id, b.status, b.version,
           CASE WHEN ${scopeSql(viewer, 'client', 'client.read', { alias: 'cl' })} THEN cl.name ELSE '' END AS client_name
      FROM bookings b JOIN clients cl ON cl.id = b.client_id
     WHERE b.id = ANY(${[...ids]})`;
}

/** Даты активных будущих консультаций клиента (до блокировки дней: карточка уже заблокирована, записи клиента не меняются). */
export async function listClientConsultDates(sql: Sql, a: { spaceId: string; clientId: string }): Promise<string[]> {
  const rows = await sql<{ bookingDate: string }>`
    SELECT DISTINCT b.booking_date FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.kind = 'individual' AND b.status = ANY(${ACTIVE})`;
  return rows.map((r) => r.bookingDate);
}

// ---------------------------------------------------------------------------
// График и исключения
// ---------------------------------------------------------------------------

export async function listScheduleRows(sql: Sql, resourceId: string): Promise<ScheduleRow[]> {
  return sql<ScheduleRow>`
    SELECT s.resource_id, s.weekday, s.start_time, s.end_time FROM resource_schedule s
     WHERE s.resource_id = ${resourceId} ORDER BY s.weekday, s.start_time`;
}

export async function replaceScheduleRows(sql: Sql, a: { resourceId: string; windows: readonly { weekday: number; start: string; end: string }[] }): Promise<void> {
  await sql`DELETE FROM resource_schedule WHERE resource_id = ${a.resourceId}`;
  for (const w of a.windows) {
    await sql`
      INSERT INTO resource_schedule (id, resource_id, weekday, start_time, end_time)
      VALUES (${newId()}, ${a.resourceId}, ${w.weekday}, ${w.start}, ${w.end})`;
  }
}

export async function listExceptionRows(sql: Sql, a: { resourceId: string; fromDay: string }): Promise<ExceptionRow[]> {
  return sql<ExceptionRow>`
    SELECT e.resource_id, e.day, e.kind, e.windows FROM resource_exceptions e
     WHERE e.resource_id = ${a.resourceId} AND e.day >= ${a.fromDay} ORDER BY e.day`;
}

export async function upsertExceptionRow(
  sql: Sql,
  a: { resourceId: string; day: string; kind: booking.ExceptionKind; windows: readonly booking.TimeRange[]; createdBy: string | null; at: number },
): Promise<void> {
  await sql`
    INSERT INTO resource_exceptions (id, resource_id, day, kind, windows, created_by, created_at)
    VALUES (${newId()}, ${a.resourceId}, ${a.day}, ${a.kind}, ${jsonParam(a.windows.map((w) => ({ start: w.start, end: w.end })))}, ${a.createdBy}, ${a.at})
    ON CONFLICT (resource_id, day) DO UPDATE SET kind = EXCLUDED.kind, windows = EXCLUDED.windows`;
}

export async function deleteExceptionRow(sql: Sql, a: { resourceId: string; day: string }): Promise<void> {
  await sql`DELETE FROM resource_exceptions WHERE resource_id = ${a.resourceId} AND day = ${a.day}`;
}

// ---------------------------------------------------------------------------
// Назначение, резерв, «серые»
// ---------------------------------------------------------------------------

/** Назначить консультанта записи; версия и охват `booking.manage` проверяются в WHERE. Не совпало — null. */
export async function assignBookingRow(
  actor: Viewer,
  sql: Sql,
  a: { id: string; version: number; resourceId: string; durationMin: number; at: number },
): Promise<BookingRow | null> {
  const rows = await scoped(sql)<BookingRow>`
    UPDATE bookings b SET resource_id = ${a.resourceId}, is_reserve = FALSE, duration_min = ${a.durationMin},
           grey_processed_at = COALESCE(b.grey_processed_at, ${a.at}), version = b.version + 1, updated_at = ${a.at}
     WHERE b.id = ${a.id} AND b.version = ${a.version} AND ${scopeSql(actor, 'booking', 'booking.manage')}
    RETURNING b.*`;
  return rows[0] ?? null;
}

/** Автоназначение: «серая» заявка ещё без консультанта и живая; иначе её уже обработал человек. */
export async function assignGreyRow(sql: Sql, a: { id: string; resourceId: string; durationMin: number; at: number }): Promise<BookingRow | null> {
  const rows = await sql<BookingRow>`
    UPDATE bookings b SET resource_id = ${a.resourceId}, is_reserve = FALSE, duration_min = ${a.durationMin},
           grey_processed_at = ${a.at}, version = b.version + 1, updated_at = ${a.at}
     WHERE b.id = ${a.id} AND b.resource_id IS NULL AND b.status = ANY(${ACTIVE})
    RETURNING b.*`;
  return rows[0] ?? null;
}

export interface GreyDetailRow {
  id: string;
  spaceId: string;
  clientId: string;
  cardId: string;
  dealId: string | null;
  startsAt: number;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  version: number;
  status: booking.BookingStatus;
}

export async function listGreyDetails(sql: Sql, ids: readonly string[]): Promise<GreyDetailRow[]> {
  if (ids.length === 0) return [];
  return sql<GreyDetailRow>`
    SELECT b.id, b.space_id, b.client_id, b.card_id, b.deal_id, b.starts_at, b.booked_by_user_id, b.responsible_user_id, b.version, b.status
      FROM bookings b WHERE b.id = ANY(${[...ids]}) ORDER BY b.id`;
}

/** Занимающие место записи консультанта, пересекающиеся с интервалом, под блокировкой (повышение резерва). */
export async function lockSlotBookings(sql: Sql, a: { resourceId: string; date: string; startMin: number; endMin: number }): Promise<(BookingRow & { startMin: number })[]> {
  const rows = await sql<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.resource_id = ${a.resourceId} AND b.booking_date = ${a.date} AND b.status = ANY(${OCCUPYING})
     ORDER BY b.id
       FOR UPDATE OF b`;
  return rows
    .map((r) => ({ ...r, startMin: booking.timeToMin(r.startTime) }))
    .filter((r) => r.startMin < a.endMin && r.startMin + r.durationMin > a.startMin);
}

export async function promoteBookingRow(sql: Sql, a: { id: string; at: number }): Promise<void> {
  await sql`UPDATE bookings b SET is_reserve = FALSE, version = b.version + 1, updated_at = ${a.at} WHERE b.id = ${a.id}`;
}

// ---------------------------------------------------------------------------
// Колокол, лента, заметки, задачи
// ---------------------------------------------------------------------------

/** Колокол: только id и числа в params; повтор по `dedupe_key` ничего не пишет. */
export async function insertBookingNotification(
  sql: Sql,
  a: { userId: string; kind: string; bookingId: string; dedupeKey: string; at: number; params?: Record<string, string | number> },
): Promise<void> {
  await sql`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, 'booking', ${a.bookingId}, ${jsonParam(a.params ?? {})}, ${a.dedupeKey}, ${a.at}, ${a.at})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

/** Событие ленты клиента с заданным id (идемпотентность по `client_events.id`, D-248). Повтор id — false. */
export async function insertFeedWithId(
  sql: Sql,
  e: { id: string; clientId: string; spaceId: string; dealId: string | null; kind: string; actorId: string | null; bookingId: string; at: number; data: Record<string, string | number | boolean | null> },
): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${e.id}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'booking', ${e.bookingId}, ${jsonParam(e.data)})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function findFeedById(sql: Sql, id: string): Promise<{ kind: string; refId: string; data: Record<string, unknown> } | null> {
  const rows = await sql<{ kind: string; refId: string; data: Record<string, unknown> }>`SELECT e.kind, e.ref_id, e.data FROM client_events e WHERE e.id = ${id}`;
  return rows[0] ?? null;
}

/** Заметка итога встречи (`notes.id = opId`): текст — ПДн, в ленту уходит только id. */
export async function insertNote(sql: Sql, n: { id: string; clientId: string; spaceId: string; dealId: string | null; authorId: string; body: string; at: number }): Promise<void> {
  await sql`
    INSERT INTO notes (id, client_id, space_id, deal_id, author_id, body, pinned, created_at)
    VALUES (${n.id}, ${n.clientId}, ${n.spaceId}, ${n.dealId}, ${n.authorId}, ${n.body}, FALSE, ${n.at})`;
}

export async function insertNoteFeed(sql: Sql, e: { clientId: string; spaceId: string; dealId: string | null; actorId: string; noteId: string; at: number }): Promise<void> {
  await sql`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, 'note.created', ${e.actorId}, ${e.at}, 'note', ${e.noteId}, ${jsonParam({ noteId: e.noteId })})`;
}

/** Ручная задача себе по итогу встречи (как в B7): `source_key` пуст — её можно закрыть руками. */
export async function insertManualTask(
  sql: Sql,
  t: { id: string; spaceId: string; clientId: string; dealId: string | null; kind: 'call' | 'meeting'; dueAt: number; assigneeUserId: string; at: number },
): Promise<void> {
  await sql`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
    VALUES (${t.id}, ${t.spaceId}, ${t.clientId}, ${t.dealId}, ${t.kind}, 'manual', '', ${t.dueAt}, ${t.assigneeUserId}, 'open', NULL, ${t.assigneeUserId}, ${t.at})`;
}

// ---------------------------------------------------------------------------
// «Мои консультации» (D-246)
// ---------------------------------------------------------------------------

export interface MyConsultationRow {
  id: string;
  bookingDate: string;
  startTime: string;
  durationMin: number;
  status: booking.BookingStatus;
  directionKey: string;
  isReserve: boolean;
  version: number;
  inWindow: boolean;
  clientId: string;
  cardId: string;
  dealId: string | null;
  clientName: string;
}

/**
 * Записи к ресурсам зрителя в окне дат. Охвата записей здесь нет (исключение D-246): строка нужна консультанту
 * и до того, как клиент открылся; клиент отдаётся только при `in_window` — его считает scopeSql клиента.
 */
export async function listMyConsultationRows(viewer: Viewer, sql: Sql, a: { spaceId: string; from: string; to: string }): Promise<MyConsultationRow[]> {
  return scoped(sql)<MyConsultationRow>`
    SELECT b.id, b.booking_date, b.start_time, b.duration_min, b.status, b.direction_key, b.is_reserve, b.version,
           (${scopeSql(viewer, 'client', 'client.read', { alias: 'cl' })}) AS in_window,
           b.client_id, b.card_id, b.deal_id, cl.name AS client_name
      FROM resources r
      JOIN bookings b ON b.resource_id = r.id AND b.booking_date BETWEEN ${a.from} AND ${a.to}
      JOIN clients cl ON cl.id = b.client_id
     WHERE r.user_id = ${viewer.userId} AND r.space_id = ${a.spaceId}
       AND b.status = ANY(${OCCUPYING})
     ORDER BY b.booking_date, b.start_time, b.id`;
}

/** Принадлежит ли ресурс записи зрителю (страница встречи консультанта). */
export async function isMyResourceBooking(sql: Sql, a: { bookingId: string; userId: string }): Promise<boolean> {
  const rows = await sql<{ hit: number }>`
    SELECT 1 AS hit FROM bookings b JOIN resources r ON r.id = b.resource_id
     WHERE b.id = ${a.bookingId} AND r.user_id = ${a.userId}`;
  return rows.length > 0;
}

/** Имя клиента записи для страницы встречи (охват записи уже проверен). */
export async function clientNameOf(sql: Sql, clientId: string): Promise<string> {
  const rows = await sql<{ name: string }>`SELECT cl.name FROM clients cl WHERE cl.id = ${clientId}`;
  return rows[0]?.name ?? '';
}

/** Пользователь консультанта и его имя (колокол, подпись «к кому записан»). */
export async function resourceUserOf(sql: Sql, resourceId: string): Promise<{ userId: string; name: string } | null> {
  const rows = await sql<{ userId: string; name: string }>`SELECT r.user_id, u.name FROM resources r JOIN users u ON u.id = r.user_id WHERE r.id = ${resourceId}`;
  return rows[0] ?? null;
}

export interface DealBriefRow {
  id: string;
  pipelineKey: string;
  stageKey: string;
  status: 'open' | 'won' | 'lost';
  version: number;
}

/** Сделка записи для страницы встречи: видна по охвату `deal.read` (консультанту — в окне, по отношению). */
export async function findDealBrief(viewer: Viewer, sql: Sql, dealId: string): Promise<DealBriefRow | null> {
  const rows = await scoped(sql)<DealBriefRow>`
    SELECT d.id, d.pipeline_key, d.stage_key, d.status, d.version FROM deals d
     WHERE d.id = ${dealId} AND ${scopeSql(viewer, 'deal', 'deal.read')}`;
  return rows[0] ?? null;
}
