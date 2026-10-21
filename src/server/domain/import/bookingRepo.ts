// SQL профиля «Записи» (D-324, docs/import-bookings-design.md §5, §8.2). Охват: клиенты и карточки — только с
// карточкой в пространстве РОП и в охвате `booking.create` (чужой клиент для РОП не существует), мероприятия —
// охват `booking.read`, записи — `booking.create`. Блокировки: внутри группы по id, группы в порядке
// D-251: карточки → мероприятия → записи клиентов. Запись и историю записи пишет `createBooking` (модуль
// записи); здесь — только чтение, блокировки, владелец карточки и история `import`.
import { booking } from '@crm/core';
import type { Viewer } from '@/server/access';
import { scopeSql, scoped } from '@/server/access/scope';
import { jsonParam, type Sql } from '@/server/platform/db/core';

const OCCUPYING: string[] = [...booking.OCCUPYING_STATUSES];

// ---------- Чтение (предпросмотр и применение) ----------

export interface BookingCandidateRow {
  clientId: string;
  nameNorm: string;
  orgId: string;
  iinHmac: string | null;
  cardId: string;
  state: string;
  ownerUserId: string | null;
  holdReason: string;
  touchedInCrm: boolean;
  version: number;
  phones: string[];
}

/**
 * Клиенты, у которых есть общий ключ со строками (БИН, HMAC ИИН, рабочий номер) и карточка в пространстве
 * РОП. Слитые и обезличенные не участвуют. Клиент без карточки здесь или вне охвата в выборку не попадает.
 */
export async function selectBookingCandidates(
  viewer: Viewer,
  sql: Sql,
  a: { spaceId: string; bins: readonly string[]; iinHmacs: readonly string[]; phones: readonly string[] },
): Promise<BookingCandidateRow[]> {
  if (a.bins.length + a.iinHmacs.length + a.phones.length === 0) return [];
  return scoped(sql)<BookingCandidateRow>`
    SELECT cl.id AS client_id, cl.name_norm, cl.org_id, cl.iin_hmac,
           c.id AS card_id, c.state, c.owner_user_id, c.hold_reason, c.touched_in_crm, c.version,
           COALESCE(array_agg(p.digits) FILTER (WHERE p.is_working), '{}') AS phones
      FROM clients cl
      JOIN cards c ON c.client_id = cl.id AND c.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'card', 'booking.create')}
      LEFT JOIN client_phones p ON p.client_id = cl.id
     WHERE cl.merged_into_id IS NULL AND cl.depersonalized_at IS NULL
       AND (
            (cl.org_id <> '' AND cl.org_id = ANY(${[...a.bins]}::text[]))
         OR (cl.iin_hmac IS NOT NULL AND cl.iin_hmac = ANY(${[...a.iinHmacs]}::text[]))
         OR cl.id IN (SELECT cp.client_id FROM client_phones cp WHERE cp.digits = ANY(${[...a.phones]}::text[]) AND cp.is_working)
       )
     GROUP BY cl.id, c.id
     ORDER BY cl.id`;
}

export interface BookingEventRow {
  id: string;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  capacity: number;
  status: 'scheduled' | 'cancelled';
  taken: number;
}

/** Мероприятия пространства нужных видов и дней. `taken` — тот же счёт, что `countTaken` модуля записи (D-131). */
export async function selectBookingEvents(viewer: Viewer, sql: Sql, a: { spaceId: string; groupTypes: readonly string[]; dates: readonly string[] }): Promise<BookingEventRow[]> {
  if (a.groupTypes.length === 0 || a.dates.length === 0) return [];
  return scoped(sql)<BookingEventRow>`
    SELECT e.id, e.event_type_key, e.event_date, e.start_time, e.starts_at, e.duration_min, e.capacity, e.status,
           (SELECT count(*) FROM bookings b WHERE b.event_id = e.id AND b.status = ANY(${OCCUPYING}::text[]))::int AS taken
      FROM events e
     WHERE e.space_id = ${a.spaceId} AND e.event_type_key = ANY(${[...a.groupTypes]}::text[]) AND e.event_date = ANY(${[...a.dates]}::text[])
       AND NOT (e.series_id IS NOT NULL AND e.occurrence_key IS NULL AND e.status = 'cancelled')
       AND ${scopeSql(viewer, 'event', 'booking.read')}
     ORDER BY e.id`;
}

export interface BookingOfClientRow {
  clientId: string;
  eventId: string | null;
  eventTypeKey: string;
  status: string;
  startsAt: number;
}

/** Занятые записи найденных клиентов: дубль и конфликт (§6). */
export async function selectClientBookings(viewer: Viewer, sql: Sql, a: { spaceId: string; clientIds: readonly string[] }): Promise<BookingOfClientRow[]> {
  if (a.clientIds.length === 0) return [];
  return scoped(sql)<BookingOfClientRow>`
    SELECT b.client_id, b.event_id, b.event_type_key, b.status, b.starts_at
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.client_id = ANY(${[...a.clientIds]}::text[]) AND b.status = ANY(${OCCUPYING}::text[])
       AND ${scopeSql(viewer, 'booking', 'booking.create')}`;
}

export interface PriorBookingRow {
  importKey: string;
  bookingId: string;
  stateKey: string | null;
}

/** Прошлое состояние строк (D-048): запись этого ключа в любом статусе + ключ состояния из последней истории `import`. */
export async function selectPriorBookings(viewer: Viewer, sql: Sql, a: { spaceId: string; keys: readonly string[] }): Promise<PriorBookingRow[]> {
  if (a.keys.length === 0) return [];
  return scoped(sql)<PriorBookingRow>`
    SELECT b.import_key, b.id AS booking_id, h.state_key
      FROM bookings b
      LEFT JOIN LATERAL (
        SELECT bh.meta ->> 'stateKey' AS state_key FROM booking_history bh
         WHERE bh.booking_id = b.id AND bh.action = 'import'
         ORDER BY bh.created_at DESC, bh.id DESC LIMIT 1
      ) h ON TRUE
     WHERE b.space_id = ${a.spaceId} AND b.import_key = ANY(${[...a.keys]}::text[]) AND ${scopeSql(viewer, 'booking', 'booking.create')}`;
}

export interface PairOfClientRow {
  aClientId: string;
  bClientId: string;
  status: 'open' | 'distinct';
}

/**
 * Спорные пары кандидатов (`open|distinct`, PROCESS 7.6, D-174). Без охвата РОП, как в раздаче: это проверка
 * инварианта «пара не делится», а не выдача данных — наружу уходят только коды замечаний и id сотрудника.
 */
export async function selectPairsOfClients(sql: Sql, clientIds: readonly string[]): Promise<PairOfClientRow[]> {
  if (clientIds.length === 0) return [];
  const ids = [...clientIds];
  return sql<PairOfClientRow>`
    SELECT p.a_client_id, p.b_client_id, p.status FROM dup_pairs p
     WHERE p.status IN ('open','distinct') AND (p.a_client_id = ANY(${ids}::text[]) OR p.b_client_id = ANY(${ids}::text[]))
     ORDER BY p.id`;
}

export interface PartnerCardRow {
  cardId: string;
  clientId: string;
  ownerUserId: string | null;
  state: string;
  holdReason: string;
}

/** Карточки напарников в пространстве (по одной на клиента): владелец, состояние, задержка — правило D-174. */
export async function selectPartnerCards(sql: Sql, a: { spaceId: string; clientIds: readonly string[] }): Promise<PartnerCardRow[]> {
  if (a.clientIds.length === 0) return [];
  return sql<PartnerCardRow>`
    SELECT c.id AS card_id, c.client_id, c.owner_user_id, c.state, c.hold_reason FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.client_id = ANY(${[...a.clientIds]}::text[])
     ORDER BY c.id`;
}

export interface StaffRow {
  userId: string;
  name: string;
  phoneDigits: string;
  status: string;
}

/** Сотрудники пространства для подсказки автора: любой статус членства (автор мог уволиться, заслуга остаётся, D-042). */
export async function selectSpaceStaff(sql: Sql, spaceId: string): Promise<StaffRow[]> {
  return sql<StaffRow>`
    SELECT u.id AS user_id, u.name, u.phone_digits, m.status
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = ${spaceId}
     ORDER BY u.name, u.id`;
}

/** Из userIds — те, кто состоит в пространстве (любой статус). Остальные — не участники: `bad_author`. */
export async function selectMemberIds(sql: Sql, spaceId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await sql<{ userId: string }>`SELECT user_id FROM memberships WHERE space_id = ${spaceId} AND user_id = ANY(${[...userIds]}::text[])`;
  return new Set(rows.map((r) => r.userId));
}

/** Сколько открытых задач «Уточнить договорённость» у клиентов (закроются записью, если карточка в `callback`). */
export async function countOpenClarifyOf(sql: Sql, spaceId: string, clientIds: readonly string[]): Promise<number> {
  if (clientIds.length === 0) return 0;
  const [r] = await sql<{ n: number }>`
    SELECT count(DISTINCT t.client_id)::int AS n FROM tasks t
     WHERE t.space_id = ${spaceId} AND t.client_id = ANY(${[...clientIds]}::text[]) AND t.status = 'open' AND t.source = 'clarify_import'`;
  return r?.n ?? 0;
}

/** Сколько всего открытых «Уточнить договорённость» в пространстве (что останется после применения — для РОП). */
export async function countOpenClarify(sql: Sql, spaceId: string): Promise<number> {
  const [r] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tasks WHERE space_id = ${spaceId} AND status = 'open' AND source = 'clarify_import'`;
  return r?.n ?? 0;
}

// ---------- Блокировки применения (D-251): карточки → мероприятия → записи клиентов ----------

/**
 * Карточки кандидатов (в охвате РОП) и карточки напарников спорных пар (без охвата: их не меняем, только держим
 * неизменными до записи) — одним запросом по id, чтобы порядок блокировок D-251 был общим с раздачей.
 */
export async function lockCardsOf(viewer: Viewer, sql: Sql, a: { spaceId: string; cardIds: readonly string[]; partnerCardIds?: readonly string[] }): Promise<void> {
  const partners = [...(a.partnerCardIds ?? [])];
  if (a.cardIds.length + partners.length === 0) return;
  await scoped(sql)`
    SELECT c.id FROM cards c
     WHERE c.id = ANY(${[...a.cardIds, ...partners]}::text[]) AND c.space_id = ${a.spaceId}
       AND (c.id = ANY(${partners}::text[]) OR ${scopeSql(viewer, 'card', 'booking.create')})
     ORDER BY c.id FOR UPDATE OF c`;
}

export async function lockEventsOf(viewer: Viewer, sql: Sql, a: { spaceId: string; eventIds: readonly string[] }): Promise<void> {
  if (a.eventIds.length === 0) return;
  await scoped(sql)`
    SELECT e.id FROM events e
     WHERE e.id = ANY(${[...a.eventIds]}::text[]) AND e.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'event', 'booking.read')}
     ORDER BY e.id FOR UPDATE OF e`;
}

export async function lockBookingsOfClients(viewer: Viewer, sql: Sql, a: { spaceId: string; clientIds: readonly string[] }): Promise<void> {
  if (a.clientIds.length === 0) return;
  await scoped(sql)`
    SELECT b.id FROM bookings b
     WHERE b.client_id = ANY(${[...a.clientIds]}::text[]) AND b.space_id = ${a.spaceId} AND ${scopeSql(viewer, 'booking', 'booking.create')}
     ORDER BY b.id FOR UPDATE OF b`;
}

// ---------- Запись ----------

/**
 * Карточка без владельца получает автора записи (D-222): только если её по-прежнему не ведут и не задержали.
 * 0 строк — ошибка вызывающего (откат целиком).
 */
export async function assignImportedOwner(viewer: Viewer, sql: Sql, a: { cardId: string; version: number; userId: string; now: number }): Promise<boolean> {
  const r = await scoped(sql)<{ id: string }>`
    UPDATE cards c SET owner_user_id = ${a.userId}, assigned_at = ${a.now}, version = c.version + 1, updated_at = ${a.now}
     WHERE c.id = ${a.cardId} AND c.version = ${a.version} AND c.owner_user_id IS NULL AND c.hold_reason = ''
       AND ${scopeSql(viewer, 'card', 'card.assign')}
    RETURNING c.id`;
  return r.length > 0;
}

/** Прошлое состояние строки для повтора (D-048): `booking_history.action = 'import'`, в meta только коды и ключи. */
export async function insertImportHistory(
  sql: Sql,
  h: { id: string; bookingId: string; actorId: string | null; meta: Record<string, unknown>; at: number; fromStatus: string; toStatus: string },
): Promise<void> {
  await sql`
    INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at)
    VALUES (${h.id}, ${h.bookingId}, 'import', ${h.fromStatus}, ${h.toStatus}, ${h.actorId}, ${jsonParam(h.meta)}, ${h.at})`;
}
