// Весь SQL сводки РОП (PROCESS §10). Каждый запрос — один проход по индексам схемы v1 с группировкой по оператору,
// без запросов на каждого сотрудника. Данные клиентов читаются через scopeSql; список сотрудников, расход лимита,
// пропуски и статус устройств — служебные чтения пространства по id сотрудников (в ответ идут только счётчики).
import type { calling } from '@crm/core';
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export interface StaffRow {
  userId: string;
  name: string;
  inDistribution: boolean;
  pausedOn: string;
  /** Последний день отсутствия, покрывающего сегодня; null — не отсутствует. */
  absentUntil: string | null;
}

/** Участники раздачи пространства (роли из настроек) с паузой и отсутствием на сегодня. */
export async function selectStaff(sql: Sql, a: { spaceId: string; roles: readonly string[]; today: string }): Promise<StaffRow[]> {
  return sql<StaffRow>`
    SELECT m.user_id, u.name, m.in_distribution, m.paused_on,
           (SELECT max(ab.to_day) FROM absences ab
             WHERE ab.space_id = m.space_id AND ab.user_id = m.user_id AND ab.cancelled_at IS NULL
               AND ${a.today}::text BETWEEN ab.from_day AND ab.to_day) AS absent_until
      FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.space_id = ${a.spaceId} AND m.status = 'active' AND m.role_key = ANY(${[...a.roles]}::text[])
     ORDER BY u.name, m.user_id`;
}

/** Расход лимита сегодня: выдачи по получателю и виду (индекс assign_day_idx). */
export async function selectIssuedToday(sql: Sql, a: { spaceId: string; day: string }): Promise<{ toUserId: string; kind: string; n: number }[]> {
  return sql<{ toUserId: string; kind: string; n: number }>`
    SELECT to_user_id, kind, count(*)::int AS n FROM assign_log
     WHERE space_id = ${a.spaceId} AND day = ${a.day}::text AND to_user_id IS NOT NULL GROUP BY 1, 2`;
}

export interface CallStatsRow {
  userId: string;
  outcomes: number;
  connects: number;
  lpr: number;
  hours: number;
}

/** Итоги за сутки по звонившему: всего, дозвоны, ЛПР «да» (по карточкам), часы в работе (индекс calls_stats_idx). */
export async function selectCallStats(
  viewer: Viewer,
  sql: Sql,
  a: { spaceId: string; from: number; to: number; timeZone: string; connectedKinds: readonly string[] },
): Promise<CallStatsRow[]> {
  return scoped(sql)<CallStatsRow>`
    SELECT ca.user_id,
           count(*)::int AS outcomes,
           (count(*) FILTER (WHERE ca.outcome_kind = ANY(${[...a.connectedKinds]}::text[])))::int AS connects,
           (count(DISTINCT ca.card_id) FILTER (WHERE ca.lpr = 'yes' AND ca.applied = 'applied'))::int AS lpr,
           (count(DISTINCT extract(hour FROM (to_timestamp(ca.occurred_at / 1000.0) AT TIME ZONE ${a.timeZone}::text))))::int AS hours
      FROM calls ca
     WHERE ca.space_id = ${a.spaceId} AND ca.user_id IS NOT NULL AND ca.via <> 'import'
       AND ca.occurred_at >= ${a.from}::bigint AND ca.occurred_at < ${a.to}::bigint
       AND ${scopeSql(viewer, 'call', 'card.read')}
     GROUP BY ca.user_id`;
}

export interface BookingCreatorRow {
  userId: string;
  groups: number;
  consults: number;
}

/** Записи, созданные за сутки, по автору: групповые и индивидуальные (консультации); отменённые и перенесённые не считаются. */
export async function selectBookingsCreated(viewer: Viewer, sql: Sql, a: { spaceId: string; from: number; to: number }): Promise<BookingCreatorRow[]> {
  return scoped(sql)<BookingCreatorRow>`
    SELECT b.booked_by_user_id AS user_id,
           (count(*) FILTER (WHERE b.kind = 'group'))::int AS groups,
           (count(*) FILTER (WHERE b.kind = 'individual'))::int AS consults
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.created_at >= ${a.from}::bigint AND b.created_at < ${a.to}::bigint
       AND b.status NOT IN ('cancelled','moved')
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY b.booked_by_user_id`;
}

/** Пропуски за день по оператору (индекс skips_day_idx). */
export async function selectSkips(sql: Sql, a: { spaceId: string; day: string; userIds: readonly string[] }): Promise<{ userId: string; n: number }[]> {
  if (a.userIds.length === 0) return [];
  return sql<{ userId: string; n: number }>`
    SELECT user_id, count(*)::int AS n FROM skips
     WHERE user_id = ANY(${[...a.userIds]}::text[]) AND day = ${a.day}::text AND space_id = ${a.spaceId}
     GROUP BY user_id`;
}

/** Просроченные перезвоны по владельцу (временный владелец считается владельцем; индекс cards_queue_idx). */
export async function selectOverdueCallbacks(viewer: Viewer, sql: Sql, a: { spaceId: string; bounds: calling.DueBounds }): Promise<{ userId: string; n: number }[]> {
  return scoped(sql)<{ userId: string; n: number }>`
    SELECT COALESCE(c.acting_user_id, c.owner_user_id) AS user_id, count(*)::int AS n
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NOT NULL AND c.state = 'callback' AND c.hold_reason = ''
       AND ((c.next_call_precision = 'time' AND c.next_call_at <= ${a.bounds.timeBefore}::bigint)
            OR (c.next_call_precision = 'day' AND c.next_call_at < ${a.bounds.dayBefore}::bigint))
       AND ${scopeSql(viewer, 'card', 'card.read')}
     GROUP BY 1`;
}

export interface DeviceRow {
  userId: string;
  pending: number;
  devices: number;
  lastSeenAt: number | null;
  lastFlushAt: number | null;
}

/** Неотправленные итоги по сотруднику: сумма по устройствам, последняя связь и сброс (D-063). */
export async function selectDeviceStatus(sql: Sql, a: { userIds: readonly string[] }): Promise<DeviceRow[]> {
  if (a.userIds.length === 0) return [];
  return sql<DeviceRow>`
    SELECT user_id, COALESCE(sum(pending_outbox), 0)::int AS pending, count(*)::int AS devices,
           max(seen_at) AS last_seen_at, max(last_flush_at) AS last_flush_at
      FROM device_status WHERE user_id = ANY(${[...a.userIds]}::text[]) GROUP BY user_id`;
}

/** Пул без владельца по причине задержки (индексы cards_pool_idx, cards_hold_idx). */
export async function selectPoolCounts(viewer: Viewer, sql: Sql, a: { spaceId: string }): Promise<{ ready: number; held: Record<string, number> }> {
  const rows = await scoped(sql)<{ holdReason: string; n: number }>`
    SELECT c.hold_reason, count(*)::int AS n FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.owner_user_id IS NULL AND c.state = 'new'
       AND ${scopeSql(viewer, 'card', 'card.read')}
     GROUP BY 1`;
  const held: Record<string, number> = {};
  let ready = 0;
  for (const r of rows) {
    if (r.holdReason === '') ready = r.n;
    else held[r.holdReason] = r.n;
  }
  return { ready, held };
}

/** Живые записи дня (без резерва): всего и подтвердивших, по датам. */
export async function selectBookingDays(
  viewer: Viewer,
  sql: Sql,
  a: { spaceId: string; days: readonly string[] },
): Promise<{ day: string; total: number; confirmed: number }[]> {
  return scoped(sql)<{ day: string; total: number; confirmed: number }>`
    SELECT b.booking_date AS day,
           (count(*) FILTER (WHERE b.status IN ('registered','confirmed','attended','no_show')))::int AS total,
           (count(*) FILTER (WHERE b.status IN ('confirmed','attended')))::int AS confirmed
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booking_date = ANY(${[...a.days]}::text[]) AND NOT b.is_reserve
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY b.booking_date`;
}

/** «Серые» консультации: индивидуальные записи без консультанта на сегодня и позже (частичный индекс bookings_grey_idx). */
export async function countGreyBookings(viewer: Viewer, sql: Sql, a: { spaceId: string; fromDay: string }): Promise<number> {
  const rows = await scoped(sql)<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.kind = 'individual' AND b.resource_id IS NULL
       AND b.status IN ('registered','confirmed') AND b.booking_date >= ${a.fromDay}::text
       AND ${scopeSql(viewer, 'booking', 'booking.read')}`;
  return rows[0]?.n ?? 0;
}
