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
import { INTAKE_LOCK_KEY } from '@/server/platform/db/locks';
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

/**
 * Гости мероприятия: строки — по охвату записей, имя/контакт/хвост номера — проекция без охвата клиента (D-072).
 * У гостя без записи (`via = 'walk_in'`) имя, контакт, хвост номера и автор пусты прямо в SQL (D-241): иначе лист
 * «Гость без записи» стал бы справочником «номер → название клиента». Такие гости идут в конце, чтобы порядок
 * строк не выдавал названия.
 */
export async function listGuestRows(actor: BookingActor, sql: Sql, eventId: string): Promise<GuestRow[]> {
  return scoped(sql)<GuestRow>`
    SELECT b.id AS booking_id, b.status, b.version,
           CASE WHEN b.via = 'walk_in' THEN '' ELSE cl.name END AS client_name,
           CASE WHEN b.via = 'walk_in' THEN '' ELSE COALESCE(ct.name, '') END AS contact_name,
           CASE WHEN b.via = 'walk_in' THEN '' ELSE COALESCE((SELECT right(cp.digits, 4) FROM client_phones cp WHERE cp.client_id = b.client_id
                      ORDER BY (b.contact_id IS NOT NULL AND cp.contact_id = b.contact_id) DESC, cp.is_primary DESC, cp.created_at, cp.id
                      LIMIT 1), '') END AS phone_tail,
           CASE WHEN b.via = 'walk_in' THEN '' ELSE COALESCE(u.name, '') END AS booked_by_name, b.via
      FROM bookings b
      JOIN clients cl ON cl.id = b.client_id
      LEFT JOIN contacts ct ON ct.id = b.contact_id
      LEFT JOIN users u ON u.id = b.booked_by_user_id
     WHERE b.event_id = ${eventId} AND b.status = ANY(${OCCUPYING}) AND ${scopeSql(actor, 'booking', 'booking.read')}
     ORDER BY (b.via = 'walk_in'), CASE WHEN b.via = 'walk_in' THEN '' ELSE cl.name END, b.id`;
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
  /** Консультант слота; null — «серая» заявка. */
  resourceId: string | null;
  /** Слот занят: запись лежит резервом (вместимость консультанта > 1). */
  isReserve: boolean;
  via: BookingVia;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  movedFromId: string | null;
  requestId: string;
  at: number;
}

/** Вставка заявки на консультацию (без мероприятия): «серая» или к консультанту; повтор ключа — null. */
export async function insertIndividualBooking(sql: Sql, b: NewIndividualBooking): Promise<BookingRow | null> {
  const rows = await sql<BookingRow>`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, contact_id, booking_date,
                          start_time, starts_at, duration_min, direction_key, is_reserve, status, via, booked_by_user_id,
                          responsible_user_id, moved_from_id, request_id, import_key, version, created_at, updated_at)
    VALUES (${b.id}, ${b.spaceId}, 'individual', ${b.eventTypeKey}, NULL, ${b.resourceId}, ${b.clientId}, ${b.cardId}, ${b.dealId}, ${b.contactId},
            ${b.date}, ${b.time}, ${b.startsAt}, ${b.durationMin}, ${b.directionKey}, ${b.isReserve}, 'registered', ${b.via}, ${b.bookedByUserId},
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
  e: { clientId: string; spaceId: string; dealId: string | null; kind: 'booking.created' | 'booking.moved' | 'booking.status' | 'booking.assigned'; actorId: string | null; bookingId: string; at: number; data: Record<string, string | number | boolean | null> },
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

/**
 * Даты будущих активных консультаций клиента в пространстве (без блокировки): какие дни консультаций взять под
 * блокировку до записей (карточка → день → записи, D-251). Карточка заблокирована вызывающим, поэтому набор дат
 * не меняется: перенос и новая запись клиента идут через ту же карточку.
 */
export async function listFutureIndividualDays(sql: Sql, a: { spaceId: string; clientId: string; after: number }): Promise<string[]> {
  const rows = await sql<{ day: string }>`
    SELECT DISTINCT b.booking_date AS day FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ${a.clientId} AND b.kind = 'individual'
       AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.after}
     ORDER BY 1`;
  return rows.map((r) => r.day);
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

// ---------------------------------------------------------------------------
// B4: дежурство, «Остальные не пришли», гость без записи
// (docs/deals-handoffs-design.md §2.5–2.8, решения D-241, D-242)
// ---------------------------------------------------------------------------

export type DutyEventRow = EventRow & { taken: number; unmarked: number; attended: number; noShow: number; iAmDuty: boolean };

/**
 * Мероприятия сегодня для экрана «Дежурство» (§2.8): агрегаты по всем записям без охвата записей (D-136);
 * Какие мероприятия — решает охват `event` по `booking.attend` (D-317): space/all — все, `duty_today` — своё.
 */
export async function listDutyEventRows(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; me: string; dayStart: number; dayEnd: number; eventId?: string },
): Promise<DutyEventRow[]> {
  return scoped(sql)<DutyEventRow>`
    SELECT e.*, x.taken, x.unmarked, x.attended, x.no_show,
           EXISTS (SELECT 1 FROM event_duty d WHERE d.event_id = e.id AND d.user_id = ${a.me}) AS i_am_duty
      FROM events e
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE b.status IN ('registered','confirmed','attended','no_show'))::int AS taken,
               count(*) FILTER (WHERE b.status IN ('registered','confirmed'))::int AS unmarked,
               count(*) FILTER (WHERE b.status = 'attended')::int AS attended,
               count(*) FILTER (WHERE b.status = 'no_show')::int AS no_show
          FROM bookings b WHERE b.event_id = e.id) x ON TRUE
     WHERE e.space_id = ${a.spaceId} AND e.starts_at >= ${a.dayStart} AND e.starts_at < ${a.dayEnd}
       AND e.status = 'scheduled' AND ${scopeSql(actor, 'event', 'booking.attend')}
       AND (${a.eventId ?? null}::text IS NULL OR e.id = ${a.eventId ?? null}::text)
     ORDER BY e.starts_at, e.id`;
}

/** Активные сотрудники пространства по имени: кого можно назначить дежурным (имена — не ПДн клиентов). */
export async function listDutyCandidateRows(sql: Sql, spaceId: string): Promise<{ userId: string; name: string }[]> {
  return sql<{ userId: string; name: string }>`
    SELECT u.id AS user_id, u.name FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.space_id = ${spaceId} AND m.status = 'active' AND u.status = 'active'
     ORDER BY u.name, u.id`;
}

/** Карточки записей, которые дежурный видел неотмеченными (шаг 1 §2.5, без блокировок). */
export async function cardIdsOfRestBookings(actor: BookingActor, sql: Sql, a: { eventId: string; bookingIds: readonly string[] }): Promise<string[]> {
  const rows = await scoped(sql)<{ cardId: string }>`
    SELECT DISTINCT b.card_id FROM bookings b
     WHERE b.event_id = ${a.eventId} AND b.id = ANY(${[...a.bookingIds]}) AND b.status = ANY(${ACTIVE})
       AND ${scopeSql(actor, 'booking', 'booking.attend')}`;
  return rows.map((r) => r.cardId);
}

/** Те же записи под блокировкой, в порядке id (шаг 4 §2.5): состояние читается уже после блокировок. */
export async function lockRestBookings(actor: BookingActor, sql: Sql, a: { eventId: string; bookingIds: readonly string[] }): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.event_id = ${a.eventId} AND b.id = ANY(${[...a.bookingIds]}) AND b.status = ANY(${ACTIVE})
       AND ${scopeSql(actor, 'booking', 'booking.attend')}
     ORDER BY b.id
       FOR UPDATE OF b`;
}

/** Статус записи мероприятия сменён вручную или массово: закрыть «Отметьте явку» (PROCESS 6.2, §3.4). */
export const attendanceMarkKeys = (bookingId: string): string[] => [`attendance_mark:${bookingId}:marker`, `attendance_mark:${bookingId}:lead`];

export interface WalkInCandidate {
  cardId: string;
  clientId: string;
  state: string;
  ownerUserId: string | null;
  lastTouchAt: number | null;
}

/**
 * D-241. Единственное место B4 без scopeSql: глобальный поиск номера гостя, наружу уходит только «найден /
 * новый» (как D-126). Слитые клиенты не считаются; при нескольких — последний по активности.
 */
export async function findWalkInCandidates(sql: Sql, a: { spaceId: string; digits: string }): Promise<WalkInCandidate[]> {
  return sql<WalkInCandidate>`
    SELECT c.id AS card_id, c.client_id, c.state, c.owner_user_id, c.last_touch_at
      FROM client_phones cp
      JOIN clients cl ON cl.id = cp.client_id AND cl.merged_into_id IS NULL
      JOIN cards c ON c.client_id = cl.id AND c.space_id = ${a.spaceId}
     WHERE cp.digits = ${a.digits}
     ORDER BY c.last_touch_at DESC NULLS LAST, c.id
     LIMIT 5`;
}

/** Клиент с таким номером без карточки в пространстве (D-241: карточка в пул, клиент не дублируется). */
export async function findClientWithoutCard(sql: Sql, a: { spaceId: string; digits: string }): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    SELECT cl.id FROM client_phones cp JOIN clients cl ON cl.id = cp.client_id AND cl.merged_into_id IS NULL
     WHERE cp.digits = ${a.digits}
       AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.client_id = cl.id AND c.space_id = ${a.spaceId})
     ORDER BY cl.created_at, cl.id LIMIT 1`;
  return rows[0]?.id ?? null;
}

export async function countProbesOfDay(sql: Sql, a: { userId: string; day: string }): Promise<number> {
  const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${a.userId} AND day = ${a.day}`;
  return rows[0]?.n ?? 0;
}

/** Проверка номера в общий счётчик D-040; id = ключ попытки: повтор не считается второй проверкой. */
export async function insertWalkInProbe(sql: Sql, a: { id: string; userId: string; day: string; matched: boolean; at: number }): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    INSERT INTO phone_probes (id, user_id, day, path, matched, created_at)
    VALUES (${a.id}, ${a.userId}, ${a.day}, 'walk_in', ${a.matched}, ${a.at})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

export async function findProbeOwner(sql: Sql, id: string): Promise<string | null> {
  const rows = await sql<{ userId: string }>`SELECT p.user_id FROM phone_probes p WHERE p.id = ${id}`;
  return rows[0]?.userId ?? null;
}

/** Ответ попытки гостя с номером из стоп-листа (журнал `booking.walk_in_skipped` этого мероприятия) или null. */
export async function findSkippedWalkInAnswer(sql: Sql, a: { eventId: string; requestId: string }): Promise<string | null> {
  const rows = await sql<{ answer: string | null }>`
    SELECT a.meta->>'answer' AS answer FROM audit_log a
     WHERE a.entity = 'event' AND a.entity_id = ${a.eventId} AND a.action = 'booking.walk_in_skipped'
       AND a.meta->>'requestId' = ${a.requestId}
     LIMIT 1`;
  return rows[0] ? (rows[0].answer ?? 'new') : null;
}

/** Запись истории по id (id = ключ попытки гостя): повтор отдаёт прежний ответ. */
export async function findHistoryRow(sql: Sql, id: string): Promise<{ bookingId: string; meta: Record<string, unknown> } | null> {
  const rows = await sql<{ bookingId: string; meta: Record<string, unknown> }>`SELECT h.booking_id, h.meta FROM booking_history h WHERE h.id = ${id}`;
  return rows[0] ?? null;
}

export async function eventIdOfBooking(sql: Sql, bookingId: string): Promise<string | null> {
  const rows = await sql<{ eventId: string | null }>`SELECT b.event_id FROM bookings b WHERE b.id = ${bookingId}`;
  return rows[0]?.eventId ?? null;
}

/** Записи клиента на этом мероприятии, держащие место, под блокировкой (гость пришёл, хотя был записан). */
export async function lockClientEventBookings(sql: Sql, a: { eventId: string; clientId: string }): Promise<BookingRow[]> {
  return sql<BookingRow>`
    SELECT b.* FROM bookings b
     WHERE b.event_id = ${a.eventId} AND b.client_id = ${a.clientId} AND b.status = ANY(${OCCUPYING})
     ORDER BY b.id
       FOR UPDATE OF b`;
}

/** Открытая сделка клиента в воронке записи; сделку гостю не создаём (D-241). */
export async function findOpenDealOfClient(sql: Sql, a: { spaceId: string; clientId: string; pipelineKey: string | null }): Promise<string | null> {
  if (a.pipelineKey === null) return null;
  const rows = await sql<{ id: string }>`
    SELECT d.id FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.client_id = ${a.clientId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open'
     ORDER BY d.created_at, d.id LIMIT 1`;
  return rows[0]?.id ?? null;
}

export async function isPhoneStopListed(sql: Sql, phoneHmac: string): Promise<boolean> {
  const rows = await sql<{ hit: number }>`SELECT 1 AS hit FROM stop_list WHERE phone_hmac = ${phoneHmac}`;
  return rows.length > 0;
}

/** Блокировка приёма (D-022): новый гость создаёт клиента так же, как приём лидов. */
export async function lockIntakeForWalkIn(sql: Sql): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
}

/** Первой командой транзакции, берущей advisory-блокировку (D-251): зависшая очередь не держит соединение вечно. */
export async function setLockTimeout10s(sql: Sql): Promise<void> {
  await sql`SET LOCAL lock_timeout = '10s'`;
}

export interface NewWalkInClient {
  clientId: string;
  cardId: string;
  contactId: string;
  kind: 'company' | 'person';
  name: string;
  nameNorm: string;
  searchNorm: string;
  contactName: string;
  digits: string;
  phoneKind: string;
  sourceKey: string;
  spaceId: string;
  at: number;
}

/** Клиент, номер, контакт, источник и карточка в пул («Задержаны правилом») одним куском (§2.6 «Не найден»). */
export async function insertWalkInClient(sql: Sql, c: NewWalkInClient): Promise<void> {
  await sql`
    INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, source_key, created_at, updated_at)
    VALUES (${c.clientId}, ${c.kind}, ${c.name}, ${c.nameNorm}, ${c.searchNorm}, 'walk_in', ${c.sourceKey}, ${c.at}, ${c.at})`;
  await sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES (${c.contactId}, ${c.clientId}, ${c.contactName}, ${c.at})`;
  await sql`
    INSERT INTO client_phones (id, client_id, contact_id, digits, kind, is_working, is_primary, created_at)
    VALUES (${newId()}, ${c.clientId}, ${c.contactId}, ${c.digits}, ${c.phoneKind}, TRUE, TRUE, ${c.at})`;
  await sql`
    INSERT INTO client_sources (id, client_id, source_kind, source_key, first_seen_at)
    VALUES (${newId()}, ${c.clientId}, 'walk_in', ${c.sourceKey}, ${c.at})`;
  await insertWalkInCard(sql, { cardId: c.cardId, spaceId: c.spaceId, clientId: c.clientId, at: c.at });
}

/** Карточка в пуле с задержкой по правилу `walk_in`: автораздача её не берёт, РОП решает, кому отдать. */
export async function insertWalkInCard(sql: Sql, c: { cardId: string; spaceId: string; clientId: string; at: number }): Promise<void> {
  await sql`
    INSERT INTO cards (id, space_id, client_id, state, hold_reason, hold_code, created_at, updated_at)
    VALUES (${c.cardId}, ${c.spaceId}, ${c.clientId}, 'new', 'rule', 'walk_in', ${c.at}, ${c.at})`;
}

/** Событие ленты не из реестра записи (создание карточки гостя): только код источника. */
export async function insertCardCreatedFeed(sql: Sql, e: { clientId: string; spaceId: string; actorId: string | null; cardId: string; sourceKey: string; at: number }): Promise<void> {
  await sql`
    INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${e.spaceId}, 'card.created', ${e.actorId}, ${e.at}, 'card', ${e.cardId}, ${jsonParam({ sourceKey: e.sourceKey })})`;
}

export interface NewWalkInBooking {
  id: string;
  spaceId: string;
  event: EventRow;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  requestId: string;
  at: number;
}

/** Гость без записи: запись сразу `attended`, `via 'walk_in'`. Вместимость не проверяется — гость уже в зале. */
export async function insertWalkInBooking(sql: Sql, b: NewWalkInBooking): Promise<BookingRow | null> {
  const e = b.event;
  const rows = await sql<BookingRow>`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, contact_id, booking_date, start_time,
                          starts_at, duration_min, status, via, booked_by_user_id, responsible_user_id, request_id, version, created_at, updated_at)
    VALUES (${b.id}, ${b.spaceId}, 'group', ${e.eventTypeKey}, ${e.id}, ${b.clientId}, ${b.cardId}, ${b.dealId}, ${b.contactId},
            ${e.eventDate}, ${e.startTime}, ${e.startsAt}, ${e.durationMin}, 'attended', 'walk_in', ${b.bookedByUserId},
            ${b.responsibleUserId}, ${b.requestId}, 0, ${b.at}, ${b.at})
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
    RETURNING *`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// B5a: консультанты (ресурсы индивидуальной записи)
// ---------------------------------------------------------------------------

export interface ResourceRow {
  id: string;
  spaceId: string;
  userId: string;
  directions: string[];
  slotMin: number;
  capacity: number;
  autoAssign: boolean;
  active: boolean;
  sort: number;
  createdAt: number;
  updatedAt: number;
}
export type ResourceListRow = ResourceRow & { name: string; usesSchedule: boolean };

/** Консультанты пространства: выключенные нужны экрану РОП, чтобы включить обратно. Это не данные клиентов. */
export async function listResourceRows(sql: Sql, a: { spaceId: string; includeInactive: boolean }): Promise<ResourceListRow[]> {
  return sql<ResourceListRow>`
    SELECT r.*, u.name, EXISTS (SELECT 1 FROM resource_schedule s WHERE s.resource_id = r.id) AS uses_schedule
      FROM resources r JOIN users u ON u.id = r.user_id
     WHERE r.space_id = ${a.spaceId} AND (${a.includeInactive}::boolean OR r.active)
     ORDER BY r.sort, u.name, r.id`;
}

export async function findResourceListRow(sql: Sql, a: { id: string; spaceId: string; lock: boolean }): Promise<ResourceListRow | null> {
  const rows = a.lock
    ? await sql<ResourceListRow>`
        SELECT r.*, u.name, EXISTS (SELECT 1 FROM resource_schedule s WHERE s.resource_id = r.id) AS uses_schedule
          FROM resources r JOIN users u ON u.id = r.user_id
         WHERE r.id = ${a.id} AND r.space_id = ${a.spaceId} FOR UPDATE OF r`
    : await sql<ResourceListRow>`
        SELECT r.*, u.name, EXISTS (SELECT 1 FROM resource_schedule s WHERE s.resource_id = r.id) AS uses_schedule
          FROM resources r JOIN users u ON u.id = r.user_id
         WHERE r.id = ${a.id} AND r.space_id = ${a.spaceId}`;
  return rows[0] ?? null;
}

/** Ресурс сотрудника в пространстве (UNIQUE space_id, user_id): повтор создания и «этот сотрудник уже консультант». */
export async function findResourceByUser(sql: Sql, a: { spaceId: string; userId: string }): Promise<ResourceRow | null> {
  const rows = await sql<ResourceRow>`SELECT r.* FROM resources r WHERE r.space_id = ${a.spaceId} AND r.user_id = ${a.userId}`;
  return rows[0] ?? null;
}

export async function insertResource(
  sql: Sql,
  r: { id: string; spaceId: string; userId: string; directions: readonly string[]; slotMin: number; capacity: number; autoAssign: boolean; sort: number; at: number },
): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    INSERT INTO resources (id, space_id, user_id, directions, slot_min, capacity, auto_assign, active, sort, created_at, updated_at)
    VALUES (${r.id}, ${r.spaceId}, ${r.userId}, ${[...r.directions]}::text[], ${r.slotMin}, ${r.capacity}, ${r.autoAssign}, TRUE, ${r.sort}, ${r.at}, ${r.at})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Правка по токену `updated_at`; не совпал — null (вызывающий: 409). */
export async function updateResourceRow(
  sql: Sql,
  r: { id: string; seenUpdatedAt: number; directions: readonly string[]; slotMin: number; capacity: number; autoAssign: boolean; active: boolean; sort: number; updatedAt: number },
): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    UPDATE resources r
       SET directions = ${[...r.directions]}::text[], slot_min = ${r.slotMin}, capacity = ${r.capacity}, auto_assign = ${r.autoAssign},
           active = ${r.active}, sort = ${r.sort}, updated_at = ${r.updatedAt}
     WHERE r.id = ${r.id} AND r.updated_at = ${r.seenUpdatedAt}
    RETURNING r.id`;
  return rows.length > 0;
}

/** Дежурные нескольких мероприятий с именами сотрудников (страница мероприятий РОП). */
export async function listDutyNameRows(sql: Sql, eventIds: readonly string[]): Promise<{ eventId: string; userId: string; name: string }[]> {
  if (eventIds.length === 0) return [];
  return sql<{ eventId: string; userId: string; name: string }>`
    SELECT d.event_id, d.user_id, u.name FROM event_duty d JOIN users u ON u.id = d.user_id
     WHERE d.event_id = ANY(${[...eventIds]})
     ORDER BY d.event_id, u.name, u.id`;
}

/** Активные сотрудники пространства, которые ещё не консультанты (выбор при создании). */
export async function listStaffWithoutResource(sql: Sql, spaceId: string): Promise<{ userId: string; name: string }[]> {
  return sql<{ userId: string; name: string }>`
    SELECT u.id AS user_id, u.name FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.space_id = ${spaceId} AND m.status = 'active' AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.space_id = ${spaceId} AND r.user_id = u.id)
     ORDER BY u.name, u.id`;
}

/** Сделка открыта и принадлежит карточке (проверка порта явки № 33: запись из открытой сделки этой карточки). */
export async function isOpenDealOfCard(sql: Sql, a: { dealId: string; cardId: string }): Promise<boolean> {
  const rows = await sql<{ id: string }>`SELECT id FROM deals WHERE id = ${a.dealId} AND card_id = ${a.cardId} AND status = 'open'`;
  return rows.length > 0;
}
