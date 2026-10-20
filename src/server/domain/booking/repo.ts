// Весь SQL записи на мероприятия (docs/booking-design.md §5). Первый аргумент каждой функции — исполнитель
// (Viewer или SystemActor), второй — соединение транзакции. Строки записей, мероприятий и карточек клиента
// выбираются только через scopeSql; места мероприятия («осталось N из M») — агрегат без охвата записей
// (D-136). Порядок блокировок во всех путях: карточка → мероприятие → записи (D-131).
import { booking } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Permission } from '@/server/access/types';
import { writeAudit, type AuditAction, type AuditEntity } from '@/server/platform/audit';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type {
  BookingActor,
  BookingCancelReason,
  BookingVia,
  BookingView,
  EventFormat,
  EventOption,
  EventView,
  GuestRow,
  LockedCard,
  SeriesView,
} from './types';

/** Статусы, держащие место, и «активные» — из ядра, чтобы список не разошёлся с автоматом. */
const OCCUPYING: string[] = [...booking.OCCUPYING_STATUSES];
const ACTIVE: string[] = [...booking.ACTIVE_STATUSES];

export const actorUserId = (a: BookingActor): string | null => (a.kind === 'user' ? a.userId : null);

// ---------------------------------------------------------------------------
// Строки таблиц (camelCase — так их отдаёт драйвер)
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string;
  spaceId: string;
  seriesId: string | null;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  status: booking.EventStatus;
  occurrenceKey: string | null;
  touched: boolean;
  createdAt: number;
  updatedAt: number;
}
export type EventRowWithTaken = EventRow & { taken: number };

export interface BookingRow {
  id: string;
  spaceId: string;
  kind: booking.EventBehavior;
  eventTypeKey: string;
  eventId: string | null;
  resourceId: string | null;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  bookingDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  directionKey: string;
  isReserve: boolean;
  status: booking.BookingStatus;
  cancelReason: BookingCancelReason;
  via: BookingVia;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  movedFromId: string | null;
  movedToId: string | null;
  requestId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface SeriesRow {
  id: string;
  spaceId: string;
  eventTypeKey: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Проекции
// ---------------------------------------------------------------------------

export function toEventLite(r: EventRow): booking.EventLite {
  return {
    id: r.id,
    seriesId: r.seriesId,
    eventTypeKey: r.eventTypeKey,
    eventDate: r.eventDate,
    startTime: r.startTime,
    startsAt: r.startsAt,
    durationMin: r.durationMin,
    location: r.location,
    format: r.format,
    capacity: r.capacity,
    status: r.status,
    occurrenceKey: r.occurrenceKey,
    touched: r.touched,
  };
}

export function toEventView(r: EventRow, taken: number): EventView {
  return {
    id: r.id,
    seriesId: r.seriesId,
    eventTypeKey: r.eventTypeKey,
    eventDate: r.eventDate,
    startTime: r.startTime,
    startsAt: r.startsAt,
    durationMin: r.durationMin,
    location: r.location,
    format: r.format as EventFormat | '',
    capacity: r.capacity,
    status: r.status,
    touched: r.touched,
    seats: booking.seats(r.capacity, taken),
    updatedAt: r.updatedAt,
  };
}

export function toEventOption(r: EventRowWithTaken): EventOption {
  const v = toEventView(r, r.taken);
  return {
    id: v.id,
    eventTypeKey: v.eventTypeKey,
    eventDate: v.eventDate,
    startTime: v.startTime,
    startsAt: v.startsAt,
    durationMin: v.durationMin,
    location: v.location,
    format: v.format,
    seats: v.seats,
  };
}

export function toBookingView(r: BookingRow): BookingView {
  return {
    id: r.id,
    kind: r.kind,
    eventTypeKey: r.eventTypeKey,
    eventId: r.eventId,
    resourceId: r.resourceId,
    clientId: r.clientId,
    cardId: r.cardId,
    dealId: r.dealId,
    contactId: r.contactId,
    bookingDate: r.bookingDate,
    startTime: r.startTime,
    startsAt: r.startsAt,
    durationMin: r.durationMin,
    directionKey: r.directionKey,
    isReserve: r.isReserve,
    status: r.status,
    cancelReason: r.cancelReason,
    via: r.via,
    bookedByUserId: r.bookedByUserId,
    responsibleUserId: r.responsibleUserId,
    movedFromId: r.movedFromId,
    movedToId: r.movedToId,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toSeriesLite(r: SeriesRow): booking.EventSeries {
  return {
    id: r.id,
    eventTypeKey: r.eventTypeKey,
    weekday: r.weekday,
    startTime: r.startTime,
    durationMin: r.durationMin,
    location: r.location,
    format: r.format,
    capacity: r.capacity,
    active: r.active,
  };
}

export function toSeriesView(r: SeriesRow, skipped: booking.SkippedOccurrence[]): SeriesView {
  return {
    id: r.id,
    eventTypeKey: r.eventTypeKey,
    weekday: r.weekday,
    startTime: r.startTime,
    durationMin: r.durationMin,
    location: r.location,
    format: r.format as EventFormat | '',
    capacity: r.capacity,
    active: r.active,
    updatedAt: r.updatedAt,
    skipped,
  };
}

/** Запись клиента для решения «новая или перенос» (NULL автора ядро получает как '', D-042). */
export function toClientBookingLite(r: BookingRow): booking.ClientBookingLite {
  return { id: r.id, status: r.status, eventTypeKey: r.eventTypeKey, eventId: r.eventId, startsAt: r.startsAt, bookedByUserId: r.bookedByUserId ?? '' };
}

// ---------------------------------------------------------------------------
// Карточки: блокировка клиента в пространстве (PROCESS 12.18)
// ---------------------------------------------------------------------------

/**
 * Карточка клиента в пространстве, видимая исполнителю по `perm`; `lock` — `FOR UPDATE`. Не видна — null
 * (вызывающий бросает 404: чужая карточка неотличима от несуществующей).
 */
export async function findCardByClient(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; clientId: string; perm: Permission; lock: boolean },
): Promise<LockedCard | null> {
  const q = scoped(sql);
  const rows = a.lock
    ? await q<LockedCard>`
        SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
          FROM cards c
         WHERE c.space_id = ${a.spaceId} AND c.client_id = ${a.clientId} AND ${scopeSql(actor, 'card', a.perm)}
           FOR UPDATE OF c`
    : await q<LockedCard>`
        SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
          FROM cards c
         WHERE c.space_id = ${a.spaceId} AND c.client_id = ${a.clientId} AND ${scopeSql(actor, 'card', a.perm)}`;
  return rows[0] ?? null;
}

/**
 * Блокировка карточки записи в действиях над статусом. Охват уже проверен на самой записи, а дежурному
 * карточка в охвате не видна (D-072), поэтому охвата карточки здесь нет.
 */
export async function lockCardOfBooking(sql: Sql, cardId: string): Promise<LockedCard | null> {
  const rows = await sql<LockedCard>`
    SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
      FROM cards c WHERE c.id = ${cardId} FOR UPDATE OF c`;
  return rows[0] ?? null;
}

/** Карточки в порядке id (порядок исключает взаимные блокировки каскада, D-131). */
export async function lockCardsInOrder(actor: BookingActor, sql: Sql, ids: readonly string[], perm: Permission): Promise<LockedCard[]> {
  if (ids.length === 0) return [];
  return scoped(sql)<LockedCard>`
    SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
      FROM cards c
     WHERE c.id = ANY(${[...ids]}) AND ${scopeSql(actor, 'card', perm)}
     ORDER BY c.id
       FOR UPDATE OF c`;
}

/** Карточки каскада отмены мероприятия: по id и пространству, без охвата (охват проверен на мероприятии). */
export async function lockEventCardsInOrder(sql: Sql, spaceId: string, ids: readonly string[]): Promise<LockedCard[]> {
  if (ids.length === 0) return [];
  return sql<LockedCard>`
    SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
      FROM cards c
     WHERE c.id = ANY(${[...ids]}) AND c.space_id = ${spaceId}
     ORDER BY c.id
       FOR UPDATE OF c`;
}

// ---------------------------------------------------------------------------
// Мероприятия
// ---------------------------------------------------------------------------

export async function findEvent(actor: BookingActor, sql: Sql, a: { eventId: string; perm: Permission; lock: boolean }): Promise<EventRow | null> {
  const q = scoped(sql);
  const rows = a.lock
    ? await q<EventRow>`SELECT e.* FROM events e WHERE e.id = ${a.eventId} AND ${scopeSql(actor, 'event', a.perm)} FOR UPDATE OF e`
    : await q<EventRow>`SELECT e.* FROM events e WHERE e.id = ${a.eventId} AND ${scopeSql(actor, 'event', a.perm)}`;
  return rows[0] ?? null;
}

/** Пространство мероприятия без охвата: нужно системному исполнителю (импорт), у которого своего пространства нет. */
export async function spaceOfEvent(sql: Sql, eventId: string): Promise<string | null> {
  const rows = await sql<{ spaceId: string }>`SELECT e.space_id FROM events e WHERE e.id = ${eventId}`;
  return rows[0]?.spaceId ?? null;
}

/** Занято мест: отдельный запрос ПОСЛЕ блокировки мероприятия (D-131). */
export async function countTaken(sql: Sql, eventId: string): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings b WHERE b.event_id = ${eventId} AND b.status = ANY(${OCCUPYING})`;
  return rows[0]?.n ?? 0;
}

/** Мероприятия окна дат; «снятые» синхронизацией серии не показываются (D-135). */
export async function listEventRows(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; from: string; to: string; eventTypeKey: string | null; includeCancelled: boolean },
): Promise<EventRowWithTaken[]> {
  return scoped(sql)<EventRowWithTaken>`
    SELECT e.*, (SELECT count(*)::int FROM bookings bk WHERE bk.event_id = e.id AND bk.status = ANY(${OCCUPYING})) AS taken
      FROM events e
     WHERE e.space_id = ${a.spaceId} AND e.event_date BETWEEN ${a.from} AND ${a.to}
       AND NOT (e.series_id IS NOT NULL AND e.occurrence_key IS NULL AND e.status = 'cancelled')
       AND (${a.eventTypeKey}::text IS NULL OR e.event_type_key = ${a.eventTypeKey}::text)
       AND (${a.includeCancelled}::boolean OR e.status = 'scheduled')
       AND ${scopeSql(actor, 'event', 'booking.read')}
     ORDER BY e.starts_at, e.id
     LIMIT 500`;
}

/** Будущие мероприятия для мастера записи: запланированные, не начавшиеся, в пределах горизонта. */
export async function listBookableEventRows(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; now: number; lastDate: string; eventTypeKey: string | null },
): Promise<EventRowWithTaken[]> {
  return scoped(sql)<EventRowWithTaken>`
    SELECT e.*, (SELECT count(*)::int FROM bookings bk WHERE bk.event_id = e.id AND bk.status = ANY(${OCCUPYING})) AS taken
      FROM events e
     WHERE e.space_id = ${a.spaceId} AND e.status = 'scheduled' AND e.starts_at > ${a.now} AND e.event_date <= ${a.lastDate}
       AND (${a.eventTypeKey}::text IS NULL OR e.event_type_key = ${a.eventTypeKey}::text)
       AND ${scopeSql(actor, 'event', 'booking.read')}
     ORDER BY e.starts_at, e.id
     LIMIT 500`;
}

export interface NewEvent {
  id: string;
  spaceId: string;
  seriesId: string | null;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  occurrenceKey: string | null;
  at: number;
}

/** Вставка мероприятия; повтор id или ключа вхождения ничего не создаёт (false). */
export async function insertEvent(sql: Sql, e: NewEvent): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format,
                        capacity, status, occurrence_key, touched, created_at, updated_at)
    VALUES (${e.id}, ${e.spaceId}, ${e.seriesId}, ${e.eventTypeKey}, ${e.eventDate}, ${e.startTime}, ${e.startsAt}, ${e.durationMin},
            ${e.location}, ${e.format}, ${e.capacity}, 'scheduled', ${e.occurrenceKey}, FALSE, ${e.at}, ${e.at})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function findEventPlain(sql: Sql, eventId: string): Promise<EventRow | null> {
  const rows = await sql<EventRow>`SELECT e.* FROM events e WHERE e.id = ${eventId}`;
  return rows[0] ?? null;
}

/** Ручная правка: `touched = TRUE` — генерация серии такое мероприятие больше не трогает. */
export async function updateEventRow(
  actor: BookingActor,
  sql: Sql,
  a: { eventId: string; seenUpdatedAt: number; next: Pick<EventRow, 'eventDate' | 'startTime' | 'startsAt' | 'durationMin' | 'location' | 'format' | 'capacity'>; updatedAt: number },
): Promise<EventRow | null> {
  const n = a.next;
  const rows = await scoped(sql)<EventRow>`
    UPDATE events e
       SET event_date = ${n.eventDate}, start_time = ${n.startTime}, starts_at = ${n.startsAt}, duration_min = ${n.durationMin},
           location = ${n.location}, format = ${n.format}, capacity = ${n.capacity}, touched = TRUE, updated_at = ${a.updatedAt}
     WHERE e.id = ${a.eventId} AND e.updated_at = ${a.seenUpdatedAt} AND ${scopeSql(actor, 'event', 'booking.manage')}
    RETURNING e.*`;
  return rows[0] ?? null;
}

export async function cancelEventRow(actor: BookingActor, sql: Sql, a: { eventId: string; updatedAt: number }): Promise<EventRow | null> {
  const rows = await scoped(sql)<EventRow>`
    UPDATE events e SET status = 'cancelled', touched = TRUE, updated_at = ${a.updatedAt}
     WHERE e.id = ${a.eventId} AND ${scopeSql(actor, 'event', 'booking.manage')}
    RETURNING e.*`;
  return rows[0] ?? null;
}

/** Дежурные мероприятия. */
export async function listDutyUserIds(sql: Sql, eventId: string): Promise<string[]> {
  const rows = await sql<{ userId: string }>`SELECT d.user_id FROM event_duty d WHERE d.event_id = ${eventId} ORDER BY d.user_id`;
  return rows.map((r) => r.userId);
}

/** Активные сотрудники пространства среди `userIds` (дежурным может быть только такой). */
export async function activeMemberIds(sql: Sql, spaceId: string, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await sql<{ id: string }>`
    SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.space_id = ${spaceId} AND m.status = 'active' AND u.status = 'active' AND u.id = ANY(${[...userIds]})`;
  return rows.map((r) => r.id);
}

export async function replaceDuty(sql: Sql, a: { eventId: string; userIds: readonly string[]; createdBy: string | null; at: number }): Promise<void> {
  await sql`DELETE FROM event_duty WHERE event_id = ${a.eventId}`;
  if (a.userIds.length === 0) return;
  await sql`
    INSERT INTO event_duty (event_id, user_id, created_by, created_at)
    SELECT ${a.eventId}, u, ${a.createdBy}, ${a.at} FROM unnest(${[...a.userIds]}::text[]) AS u`;
}

/** Гости мероприятия: строки — по охвату записей, имя/контакт/хвост номера — проекция без охвата клиента (D-072). */
export async function listGuestRows(actor: BookingActor, sql: Sql, eventId: string): Promise<GuestRow[]> {
  return scoped(sql)<GuestRow>`
    SELECT b.id AS booking_id, b.status, b.version, cl.name AS client_name, COALESCE(ct.name, '') AS contact_name,
           COALESCE((SELECT right(cp.digits, 4) FROM client_phones cp WHERE cp.client_id = b.client_id
                      ORDER BY (b.contact_id IS NOT NULL AND cp.contact_id = b.contact_id) DESC, cp.is_primary DESC, cp.created_at, cp.id
                      LIMIT 1), '') AS phone_tail,
           COALESCE(u.name, '') AS booked_by_name, b.via
      FROM bookings b
      JOIN clients cl ON cl.id = b.client_id
      LEFT JOIN contacts ct ON ct.id = b.contact_id
      LEFT JOIN users u ON u.id = b.booked_by_user_id
     WHERE b.event_id = ${eventId} AND b.status = ANY(${OCCUPYING}) AND ${scopeSql(actor, 'booking', 'booking.read')}
     ORDER BY cl.name, b.id`;
}

// ---------------------------------------------------------------------------
// Серии
// ---------------------------------------------------------------------------

export async function listSeriesRows(sql: Sql, spaceId: string): Promise<SeriesRow[]> {
  return sql<SeriesRow>`SELECT s.* FROM event_series s WHERE s.space_id = ${spaceId} ORDER BY s.event_type_key, s.weekday, s.start_time, s.id`;
}

export async function findSeries(sql: Sql, seriesId: string, lock: boolean): Promise<SeriesRow | null> {
  const rows = lock
    ? await sql<SeriesRow>`SELECT s.* FROM event_series s WHERE s.id = ${seriesId} FOR UPDATE OF s`
    : await sql<SeriesRow>`SELECT s.* FROM event_series s WHERE s.id = ${seriesId}`;
  return rows[0] ?? null;
}

/** Активные серии всех пространств (job `events-ensure`). */
export async function listActiveSeriesIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }>`SELECT s.id FROM event_series s WHERE s.active ORDER BY s.space_id, s.id`;
  return rows.map((r) => r.id);
}

/** Самая свежая действующая серия вида: умолчания места и формата разового мероприятия. */
export async function latestActiveSeriesOfType(sql: Sql, spaceId: string, eventTypeKey: string): Promise<SeriesRow | null> {
  const rows = await sql<SeriesRow>`
    SELECT s.* FROM event_series s
     WHERE s.space_id = ${spaceId} AND s.event_type_key = ${eventTypeKey} AND s.active
     ORDER BY s.updated_at DESC, s.id LIMIT 1`;
  return rows[0] ?? null;
}

export async function insertSeries(sql: Sql, s: Omit<SeriesRow, 'createdAt' | 'updatedAt' | 'active'> & { at: number }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    INSERT INTO event_series (id, space_id, event_type_key, weekday, start_time, duration_min, location, format, capacity, active, created_at, updated_at)
    VALUES (${s.id}, ${s.spaceId}, ${s.eventTypeKey}, ${s.weekday}, ${s.startTime}, ${s.durationMin}, ${s.location}, ${s.format}, ${s.capacity},
            TRUE, ${s.at}, ${s.at})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

export async function updateSeriesRow(sql: Sql, s: Omit<SeriesRow, 'createdAt' | 'spaceId'> & { updatedAt: number }): Promise<SeriesRow | null> {
  const rows = await sql<SeriesRow>`
    UPDATE event_series s
       SET event_type_key = ${s.eventTypeKey}, weekday = ${s.weekday}, start_time = ${s.startTime}, duration_min = ${s.durationMin},
           location = ${s.location}, format = ${s.format}, capacity = ${s.capacity}, active = ${s.active}, updated_at = ${s.updatedAt}
     WHERE s.id = ${s.id}
    RETURNING s.*`;
  return rows[0] ?? null;
}

/**
 * Мероприятия серии от даты, кроме «снятых», под блокировкой; числа записей и дежурных считаются тут же,
 * уже после блокировки (D-135): новый оператор видит всё зафиксированное.
 */
export async function lockSeriesEvents(sql: Sql, seriesId: string, fromDate: string): Promise<booking.ExistingEvent[]> {
  const rows = await sql<EventRow>`
    SELECT e.* FROM events e
     WHERE e.series_id = ${seriesId} AND e.event_date >= ${fromDate}
       AND NOT (e.occurrence_key IS NULL AND e.status = 'cancelled')
     ORDER BY e.id
       FOR UPDATE OF e`;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await sql<{ id: string; bookings: number; duty: number }>`
    SELECT e.id,
           (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = ANY(${OCCUPYING})) AS bookings,
           (SELECT count(*)::int FROM event_duty d WHERE d.event_id = e.id) AS duty
      FROM events e WHERE e.id = ANY(${ids})`;
  const byId = new Map(counts.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...toEventLite(r), bookingCount: byId.get(r.id)?.bookings ?? 0, dutyCount: byId.get(r.id)?.duty ?? 0 }));
}

export async function updateOccurrence(sql: Sql, a: { id: string; changes: booking.OccurrenceChange; at: number }): Promise<void> {
  const c = a.changes;
  await sql`
    UPDATE events e
       SET start_time = COALESCE(${c.startTime ?? null}::text, e.start_time),
           starts_at = COALESCE(${c.startsAt ?? null}::bigint, e.starts_at),
           duration_min = COALESCE(${c.durationMin ?? null}::int, e.duration_min),
           location = COALESCE(${c.location ?? null}::text, e.location),
           format = COALESCE(${c.format ?? null}::text, e.format),
           capacity = COALESCE(${c.capacity ?? null}::int, e.capacity),
           updated_at = ${a.at}
     WHERE e.id = ${a.id}`;
}

/** «Снять» нетронутое мероприятие: у `crm_app` нет DELETE на events, ключ вхождения освобождается (D-135). */
export async function retireEvents(sql: Sql, ids: readonly string[], at: number): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE events e SET status = 'cancelled', occurrence_key = NULL, updated_at = ${at} WHERE e.id = ANY(${[...ids]})`;
}

// ---------------------------------------------------------------------------
// Записи
// ---------------------------------------------------------------------------

export async function findBooking(actor: BookingActor, sql: Sql, a: { id: string; perm: Permission; lock: boolean }): Promise<BookingRow | null> {
  const q = scoped(sql);
  const rows = a.lock
    ? await q<BookingRow>`SELECT b.* FROM bookings b WHERE b.id = ${a.id} AND ${scopeSql(actor, 'booking', a.perm)} FOR UPDATE OF b`
    : await q<BookingRow>`SELECT b.* FROM bookings b WHERE b.id = ${a.id} AND ${scopeSql(actor, 'booking', a.perm)}`;
  return rows[0] ?? null;
}

/** По ключу запроса; вызывается под блокировкой карточки, наружу уходит только после сверки клиента и мероприятия. */
export async function findBookingByRequestId(sql: Sql, requestId: string): Promise<BookingRow | null> {
  const rows = await sql<BookingRow>`SELECT b.* FROM bookings b WHERE b.request_id = ${requestId}`;
  return rows[0] ?? null;
}

/** Записи клиента, держащие место, под блокировкой: для решения «новая запись или перенос». */
export async function lockClientBookings(actor: BookingActor, sql: Sql, a: { spaceId: string; clientId: string; perm: Permission }): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.status = ANY(${OCCUPYING})
       AND ${scopeSql(actor, 'booking', a.perm)}
     ORDER BY b.id
       FOR UPDATE OF b`;
}

/** Активные будущие записи клиента (мастер: «перенос с …»). */
export async function listActiveFutureBookings(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; clientId: string; now: number; perm: Permission; kind?: 'group' | 'individual' },
): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.kind = ${a.kind ?? 'group'}
       AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.now} AND ${scopeSql(actor, 'booking', a.perm)}
     ORDER BY b.starts_at, b.id`;
}

export interface NewBooking {
  id: string;
  spaceId: string;
  event: EventRow;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  via: BookingVia;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  movedFromId: string | null;
  requestId: string;
  importKey: string | null;
  at: number;
}

/** Вставка групповой записи; повтор ключа запроса ничего не вставляет (null). */
export async function insertGroupBooking(sql: Sql, b: NewBooking): Promise<BookingRow | null> {
  const e = b.event;
  const rows = await sql<BookingRow>`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, contact_id, booking_date, start_time,
                          starts_at, duration_min, status, via, booked_by_user_id, responsible_user_id, moved_from_id, request_id,
                          import_key, version, created_at, updated_at)
    VALUES (${b.id}, ${b.spaceId}, 'group', ${e.eventTypeKey}, ${e.id}, ${b.clientId}, ${b.cardId}, ${b.dealId}, ${b.contactId},
            ${e.eventDate}, ${e.startTime}, ${e.startsAt}, ${e.durationMin}, 'registered', ${b.via}, ${b.bookedByUserId},
            ${b.responsibleUserId}, ${b.movedFromId}, ${b.requestId}, ${b.importKey}, 0, ${b.at}, ${b.at})
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
    RETURNING *`;
  return rows[0] ?? null;
}

export interface NewIndividualBooking {
  id: string;
  spaceId: string;
  eventTypeKey: string;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  date: string;
  time: string;
  startsAt: number;
  durationMin: number;
  directionKey: string;
  via: BookingVia;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  movedFromId: string | null;
  requestId: string;
  at: number;
}

/** Вставка «серой» заявки на консультацию (без консультанта, без мероприятия); повтор ключа — null. */
export async function insertIndividualBooking(sql: Sql, b: NewIndividualBooking): Promise<BookingRow | null> {
  const rows = await sql<BookingRow>`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, contact_id, booking_date,
                          start_time, starts_at, duration_min, direction_key, is_reserve, status, via, booked_by_user_id,
                          responsible_user_id, moved_from_id, request_id, import_key, version, created_at, updated_at)
    VALUES (${b.id}, ${b.spaceId}, 'individual', ${b.eventTypeKey}, NULL, NULL, ${b.clientId}, ${b.cardId}, ${b.dealId}, ${b.contactId},
            ${b.date}, ${b.time}, ${b.startsAt}, ${b.durationMin}, ${b.directionKey}, FALSE, 'registered', ${b.via}, ${b.bookedByUserId},
            ${b.responsibleUserId}, ${b.movedFromId}, ${b.requestId}, NULL, 0, ${b.at}, ${b.at})
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
    RETURNING *`;
  return rows[0] ?? null;
}

/** Старая запись переноса → `moved` с обратной ссылкой; не совпала версия — null. */
export async function markMoved(actor: BookingActor, sql: Sql, a: { id: string; version: number; toId: string; at: number }): Promise<BookingRow | null> {
  const rows = await scoped(sql)<BookingRow>`
    UPDATE bookings b SET status = 'moved', moved_to_id = ${a.toId}, version = b.version + 1, updated_at = ${a.at}
     WHERE b.id = ${a.id} AND b.version = ${a.version} AND ${scopeSql(actor, 'booking', 'booking.create')}
    RETURNING b.*`;
  return rows[0] ?? null;
}

/** Смена статуса с проверкой версии и охвата; не совпало — null (вызывающий: 404 или 409). */
export async function updateStatus(
  actor: BookingActor,
  sql: Sql,
  a: { id: string; version: number; to: booking.BookingStatus; cancelReason: BookingCancelReason; perm: Permission; at: number },
): Promise<BookingRow | null> {
  const rows = await scoped(sql)<BookingRow>`
    UPDATE bookings b SET status = ${a.to}, cancel_reason = ${a.cancelReason}, version = b.version + 1, updated_at = ${a.at}
     WHERE b.id = ${a.id} AND b.version = ${a.version} AND ${scopeSql(actor, 'booking', a.perm)}
    RETURNING b.*`;
  return rows[0] ?? null;
}

export async function listBookingRows(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; from: string; to: string; statuses: readonly string[] | null; eventId: string | null; clientId: string | null; limit: number },
): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from} AND ${a.to}
       AND (${a.statuses === null}::boolean OR b.status = ANY(${a.statuses === null ? [] : [...a.statuses]}::text[]))
       AND (${a.eventId}::text IS NULL OR b.event_id = ${a.eventId}::text)
       AND (${a.clientId}::text IS NULL OR b.client_id = ${a.clientId}::text)
       AND ${scopeSql(actor, 'booking', 'booking.read')}
     ORDER BY b.starts_at, b.id
     LIMIT ${a.limit}`;
}

/** Есть ли у клиента другая активная будущая запись (факт для событий карточки; считается после изменения). */
export async function hasOtherFutureBooking(sql: Sql, a: { spaceId: string; clientId: string; excludeId: string; now: number }): Promise<boolean> {
  const rows = await sql<{ hit: number }>`
    SELECT 1 AS hit FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.id <> ${a.excludeId}
       AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.now}
     LIMIT 1`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// История и лента
// ---------------------------------------------------------------------------

export async function findHistoryBookingId(sql: Sql, historyId: string): Promise<string | null> {
  const rows = await sql<{ bookingId: string }>`SELECT h.booking_id FROM booking_history h WHERE h.id = ${historyId}`;
  return rows[0]?.bookingId ?? null;
}

/** Когда последний раз поставили «Не пришёл» (исправление явки, № 31). */
export async function lastNoShowAt(sql: Sql, bookingId: string): Promise<number | null> {
  const rows = await sql<{ at: number | null }>`SELECT max(h.created_at) AS at FROM booking_history h WHERE h.booking_id = ${bookingId} AND h.to_status = 'no_show'`;
  return rows[0]?.at ?? null;
}

export async function insertHistory(
  sql: Sql,
  h: { id?: string; bookingId: string; action: string; from: string; to: string; actorId: string | null; meta: Record<string, unknown>; at: number },
): Promise<void> {
  await sql`
    INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at)
    VALUES (${h.id ?? newId()}, ${h.bookingId}, ${h.action}, ${h.from}, ${h.to}, ${h.actorId}, ${jsonParam(h.meta)}, ${h.at})`;
}

/** Лента клиента (client_events): только коды, id и числа без ПДн (D-020). */
export async function insertFeed(
  sql: Sql,
  e: { clientId: string; spaceId: string; dealId: string | null; kind: 'booking.created' | 'booking.moved' | 'booking.status'; actorId: string | null; bookingId: string; at: number; data: Record<string, string | number | boolean | null> },
): Promise<void> {
  await sql`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'booking', ${e.bookingId}, ${jsonParam(e.data)})`;
}

// ---------------------------------------------------------------------------
// Каскад отмены мероприятия
// ---------------------------------------------------------------------------

// Каскад идёт без охвата отменяющего: право отменить мероприятие проверено, а записи остальных менеджеров
// пространства не должны остаться активными на отменённом мероприятии.
export async function activeCardIdsOfEvent(sql: Sql, eventId: string): Promise<string[]> {
  const rows = await sql<{ cardId: string }>`
    SELECT DISTINCT b.card_id FROM bookings b
     WHERE b.event_id = ${eventId} AND b.status = ANY(${ACTIVE})`;
  return rows.map((r) => r.cardId);
}

export async function lockActiveBookingsOfEvent(sql: Sql, eventId: string): Promise<BookingRow[]> {
  return sql<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.event_id = ${eventId} AND b.status = ANY(${ACTIVE})
     ORDER BY b.id
       FOR UPDATE OF b`;
}

/** Отмена записи мероприятия или будущей записи клиента: статус и причина, версия растёт. Записи уже заблокированы. */
export async function cancelBookingRows(sql: Sql, ids: readonly string[], reason: BookingCancelReason, at: number): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE bookings b SET status = 'cancelled', cancel_reason = ${reason}, version = b.version + 1, updated_at = ${at} WHERE b.id = ANY(${[...ids]})`;
}

// ---------------------------------------------------------------------------
// Эффекты карточки (cancel_future, reassign_future)
// ---------------------------------------------------------------------------

/**
 * Будущие активные записи клиента в пространстве под блокировкой. Карточку заблокировал и проверил вызывающий
 * (исполнитель эффектов), поэтому записи берутся по клиенту и пространству, а не по охвату.
 */
export async function lockFutureActiveBookings(sql: Sql, a: { spaceId: string; clientId: string; after: number }): Promise<BookingRow[]> {
  return sql<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.after}
     ORDER BY b.id
       FOR UPDATE OF b`;
}

export async function reassignBookings(sql: Sql, ids: readonly string[], to: string, at: number): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE bookings b SET responsible_user_id = ${to}, updated_at = ${at} WHERE b.id = ANY(${[...ids]})`;
}

// ---------------------------------------------------------------------------
// Контакты и журнал действий
// ---------------------------------------------------------------------------

/** Контакт принадлежит клиенту и не в архиве («кто придёт»). */
export async function contactBelongsToClient(sql: Sql, contactId: string, clientId: string): Promise<boolean> {
  const rows = await sql<{ hit: number }>`SELECT 1 AS hit FROM contacts c WHERE c.id = ${contactId} AND c.client_id = ${clientId} AND c.archived_at IS NULL`;
  return rows.length > 0;
}

/**
 * Журнал действий с мероприятиями и сериями. Имена `event.*`/`series.*` есть в реестре аудита платформы
 * (docs/booking-design.md §12).
 */
export async function auditEvent(
  sql: Sql,
  a: { actor: BookingActor; action: Extract<AuditAction, `event.${string}` | `series.${string}`>; entity: Extract<AuditEntity, 'event' | 'series'>; entityId: string; spaceId: string; meta: Record<string, unknown> },
): Promise<void> {
  await writeAudit(sql, {
    actorId: actorUserId(a.actor),
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    spaceId: a.spaceId,
    meta: a.meta,
  });
}

// ---------------------------------------------------------------------------
// B3a: мастер записи и «Записи»
// ---------------------------------------------------------------------------

export interface WizardCardRow {
  cardId: string;
  clientId: string;
  state: string;
  clientName: string;
}

/** Карточка мастера и название клиента; карточка должна быть видна по `booking.create`, иначе — null (404). */
export async function findWizardCard(actor: BookingActor, sql: Sql, a: { spaceId: string; cardId: string }): Promise<WizardCardRow | null> {
  const rows = await scoped(sql)<WizardCardRow>`
    SELECT c.id AS card_id, c.client_id, c.state, cl.name AS client_name
      FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.id = ${a.cardId} AND c.space_id = ${a.spaceId} AND ${scopeSql(actor, 'card', 'booking.create')}`;
  return rows[0] ?? null;
}

export type BookingItemRow = BookingRow & { clientName: string };

/** Строки «Записей»: охват записи, название клиента из JOIN; по времени начала. */
export async function listBookingItemRows(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; from: string; to: string; statuses: readonly string[] | null; limit: number },
): Promise<BookingItemRow[]> {
  return scoped(sql)<BookingItemRow>`
    SELECT b.*, cl.name AS client_name FROM bookings b JOIN clients cl ON cl.id = b.client_id
     WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from} AND ${a.to}
       AND (${a.statuses === null}::boolean OR b.status = ANY(${a.statuses === null ? [] : [...a.statuses]}::text[]))
       AND ${scopeSql(actor, 'booking', 'booking.read')}
     ORDER BY b.starts_at, b.id
     LIMIT ${a.limit}`;
}
