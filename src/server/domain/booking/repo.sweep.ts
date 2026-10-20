// SQL сверок записи (B4b, docs/deals-handoffs-design.md §3): неотмеченная явка и «Договорились» без шага.
// Отдельный файл рядом с repo.ts, чтобы тот не рос дальше; правила те же: первый аргумент — исполнитель
// (SystemActor воркера), охват системы не ограничен. Читаются коды и числа, ПДн не выбираются.
import { booking } from '@crm/core';
import type { Sql } from '@/server/platform/db';
import type { BookingActor } from './types';

const ACTIVE: string[] = [...booking.ACTIVE_STATUSES];
const OPEN: string[] = ['registered', 'confirmed'];

/** Окно просмотра и потолок за один прогон (§3.2). */
export const SWEEP_WINDOW_DAYS = 60;
export const SWEEP_LIMIT = 500;

/**
 * Записи, дата которых раньше сегодня, без отметки явки: групповые, к консультантам и «серые» (§3.2).
 * Порядок — по началу, потолок — `limit`.
 */
export async function listUnmarkedBookingIds(
  _actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; fromEpoch: number; todayEpoch: number; fromDay: string; today: string; limit: number },
): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM (
      SELECT b.id, b.starts_at FROM events e JOIN bookings b ON b.event_id = e.id
       WHERE e.space_id = ${a.spaceId} AND e.starts_at >= ${a.fromEpoch} AND e.starts_at < ${a.todayEpoch}
         AND b.status = ANY(${OPEN})
      UNION ALL
      SELECT b.id, b.starts_at FROM bookings b
       WHERE b.resource_id IN (SELECT r.id FROM resources r WHERE r.space_id = ${a.spaceId})
         AND b.booking_date >= ${a.fromDay} AND b.booking_date < ${a.today} AND b.status = ANY(${OPEN})
      UNION ALL
      SELECT b.id, b.starts_at FROM bookings b
       WHERE b.space_id = ${a.spaceId} AND b.kind = 'individual' AND b.resource_id IS NULL
         AND b.status = ANY(${OPEN}) AND b.booking_date >= ${a.fromDay} AND b.booking_date < ${a.today}
    ) u ORDER BY starts_at, id LIMIT ${a.limit}`;
  return rows.map((r) => r.id);
}

/** Сколько записей прошло без отметки явки (для тревоги РОП); окно и условия те же, потолка нет. */
export async function countUnmarkedBookings(_actor: BookingActor, sql: Sql, a: { spaceId: string; fromDay: string; today: string }): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booking_date >= ${a.fromDay} AND b.booking_date < ${a.today} AND b.status = ANY(${OPEN})`;
  return rows[0]?.n ?? 0;
}

/** Первый активный дежурный мероприятия (по `created_at`, затем id), состоящий в пространстве. */
export async function firstDutyUser(sql: Sql, a: { eventId: string; spaceId: string }): Promise<string | null> {
  const rows = await sql<{ userId: string }>`
    SELECT d.user_id FROM event_duty d
      JOIN users u ON u.id = d.user_id AND u.status = 'active'
      JOIN memberships m ON m.user_id = u.id AND m.space_id = ${a.spaceId} AND m.status = 'active'
     WHERE d.event_id = ${a.eventId}
     ORDER BY d.created_at, d.user_id LIMIT 1`;
  return rows[0]?.userId ?? null;
}

/** Сотрудник активного консультанта; консультант выключен или сотрудник отключён — null. */
export async function activeResourceUser(sql: Sql, a: { resourceId: string; spaceId: string }): Promise<string | null> {
  const rows = await sql<{ userId: string }>`
    SELECT r.user_id FROM resources r
      JOIN users u ON u.id = r.user_id AND u.status = 'active'
      JOIN memberships m ON m.user_id = u.id AND m.space_id = ${a.spaceId} AND m.status = 'active'
     WHERE r.id = ${a.resourceId} AND r.active`;
  return rows[0]?.userId ?? null;
}

/** Карточки «Договорились» без следующего шага в пространстве. */
export async function listAgreedWithoutStepIds(_actor: BookingActor, sql: Sql, a: { spaceId: string; now: number; limit: number }): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT c.id FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.state = 'agreed'
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.client_id AND b.space_id = c.space_id
                         AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.now})
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.client_id AND t.space_id = c.space_id
                         AND t.status = 'open' AND t.due_at IS NOT NULL)
     ORDER BY c.id LIMIT ${a.limit}`;
  return rows.map((r) => r.id);
}

/** Тот же запрос по всем пространствам: число нарушений для ночной сверки `invariants`. */
export async function countAgreedWithoutStepRows(_actor: BookingActor, sql: Sql, a: { now: number }): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM cards c
     WHERE c.state = 'agreed'
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.client_id AND b.space_id = c.space_id
                         AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.now})
       AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.client_id AND t.space_id = c.space_id
                         AND t.status = 'open' AND t.due_at IS NOT NULL)`;
  return rows[0]?.n ?? 0;
}

/** Факты шага клиента под блокировкой карточки: есть будущая запись, есть открытая задача со сроком. */
export async function stepFacts(sql: Sql, a: { spaceId: string; clientId: string; now: number }): Promise<{ hasFutureBooking: boolean; hasOpenOwnerTask: boolean }> {
  const rows = await sql<{ booking: boolean; task: boolean }>`
    SELECT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = ${a.clientId} AND b.space_id = ${a.spaceId}
                     AND b.status = ANY(${ACTIVE}) AND b.starts_at > ${a.now}) AS booking,
           EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = ${a.clientId} AND t.space_id = ${a.spaceId}
                     AND t.status = 'open' AND t.due_at IS NOT NULL) AS task`;
  return { hasFutureBooking: rows[0]?.booking ?? false, hasOpenOwnerTask: rows[0]?.task ?? false };
}
