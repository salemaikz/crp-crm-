// Весь SQL отчётов за период (R3a, дизайн §1.4). Запросы идут по индексам схемы v1 (calls_stats_idx, calls_card_idx,
// assign_day_idx, deals_board_idx, deals_client_idx, bookings_deal_idx, skips_day_idx, client_sources_client_idx) или
// коротким сканам. Данные клиентов читаются через scopeSql; assign_log, skips и users — служебные таблицы без данных
// клиентов (охват пространства проверен в getReport). Вложенных фрагментов нет: повторяющиеся куски SQL записаны явно.
// Строки приходят уже в camelCase; bigint — строкой (суммы), конвертирует вызывающий (`toKzt`).
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

/** Общие аргументы: пространство, период (мс и местные дни), пояс, фильтры. */
export interface PeriodArgs {
  spaceId: string;
  fromMs: number;
  toMs: number;
  from: string;
  to: string;
  timeZone: string;
  /** Только эти сотрудники; null — все. */
  userIds: string[] | null;
  /** Ключ источника; null — все. */
  sourceKey: string | null;
}

// ---------------------------------------------------------------------------
// Сотрудники × местный день
// ---------------------------------------------------------------------------

export interface CallsDayRow {
  userId: string;
  day: string;
  outcomes: number;
  connects: number;
  hours: number;
}

/** Итоги, дозвоны и часы в работе по звонившему и местному дню (calls_stats_idx). Импорт не считается. */
export async function callsByUserDay(viewer: Viewer, sql: Sql, a: PeriodArgs & { connectedKinds: readonly string[] }): Promise<CallsDayRow[]> {
  return scoped(sql)<CallsDayRow>`
    WITH fs AS (
      -- первый источник клиента один раз (нужен только при фильтре по источнику), а не подзапросом на звонок
      SELECT DISTINCT ON (s.client_id) s.client_id, CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END AS src
        FROM client_sources s WHERE ${a.sourceKey}::text IS NOT NULL ORDER BY s.client_id, s.first_seen_at, s.id)
    SELECT ca.user_id, to_char(to_timestamp(ca.occurred_at / 1000.0) AT TIME ZONE ${a.timeZone}::text, 'YYYY-MM-DD') AS day,
           count(*)::int AS outcomes,
           -- итог с доски (via = 'board') не звонок: в итоги входит, в дозвоны нет
           (count(*) FILTER (WHERE ca.via <> 'board' AND ca.outcome_kind = ANY(${[...a.connectedKinds]}::text[])))::int AS connects,
           (count(DISTINCT extract(hour FROM (to_timestamp(ca.occurred_at / 1000.0) AT TIME ZONE ${a.timeZone}::text))))::int AS hours
      FROM calls ca
     WHERE ca.space_id = ${a.spaceId} AND ca.user_id IS NOT NULL AND ca.via <> 'import'
       AND ca.occurred_at >= ${a.fromMs}::bigint AND ca.occurred_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR ca.user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR ca.client_id IN (SELECT fs.client_id FROM fs WHERE fs.src = ${a.sourceKey}::text))
       AND ${scopeSql(viewer, 'call', 'card.read')}
     GROUP BY 1, 2`;
}

export interface LprDayRow {
  userId: string;
  day: string;
  lpr: number;
}

/** ЛПР: карточка засчитывается по первому применённому «ЛПР да» за всё время, автору этого звонка (calls_card_idx). */
export async function lprFirstByUserDay(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<LprDayRow[]> {
  return scoped(sql)<LprDayRow>`
    WITH f AS (
      SELECT DISTINCT ON (ca.card_id) ca.card_id, ca.client_id, ca.user_id, ca.occurred_at
        FROM calls ca
       WHERE ca.space_id = ${a.spaceId} AND ca.lpr = 'yes' AND ca.applied = 'applied' AND ca.user_id IS NOT NULL
         AND ${scopeSql(viewer, 'call', 'card.read')}
       ORDER BY ca.card_id, ca.occurred_at, ca.id)
    SELECT f.user_id, to_char(to_timestamp(f.occurred_at / 1000.0) AT TIME ZONE ${a.timeZone}::text, 'YYYY-MM-DD') AS day, count(*)::int AS lpr
      FROM f
     WHERE f.occurred_at >= ${a.fromMs}::bigint AND f.occurred_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR f.user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = f.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
     GROUP BY 1, 2`;
}

export interface IssuedDayRow {
  userId: string;
  day: string;
  issued: number;
}

/** Выдано: различные карточки, новые для оператора (assign_day_idx). Охват пространства проверен в getReport. */
export async function issuedByUserDay(sql: Sql, a: PeriodArgs & { issueKinds: readonly string[] }): Promise<IssuedDayRow[]> {
  return sql<IssuedDayRow>`
    SELECT a.to_user_id AS user_id, a.day, count(DISTINCT a.card_id)::int AS issued
      FROM assign_log a
     WHERE a.space_id = ${a.spaceId} AND a.day BETWEEN ${a.from}::text AND ${a.to}::text AND a.to_user_id IS NOT NULL
       AND a.kind = ANY(${[...a.issueKinds]}::text[])
       AND (${a.userIds}::text[] IS NULL OR a.to_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s
                                              WHERE s.client_id = (SELECT c.client_id FROM cards c WHERE c.id = a.card_id)
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
     GROUP BY 1, 2`;
}

export interface BookedDayRow {
  userId: string;
  day: string;
  groups: number;
  consults: number;
}

/** Записи по автору и дню создания: головы цепочек переноса, без импорта и без «ошибки оператора» (D-261). */
export async function bookedByUserDay(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<BookedDayRow[]> {
  return scoped(sql)<BookedDayRow>`
    SELECT b.booked_by_user_id AS user_id, to_char(to_timestamp(b.created_at / 1000.0) AT TIME ZONE ${a.timeZone}::text, 'YYYY-MM-DD') AS day,
           (count(*) FILTER (WHERE b.kind = 'group'))::int AS groups,
           (count(*) FILTER (WHERE b.kind = 'individual'))::int AS consults
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND b.created_at >= ${a.fromMs}::bigint AND b.created_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2`;
}

export interface AttendedDayRow {
  userId: string;
  day: string;
  attended: number;
  noShow: number;
}

/** Явка по автору записи и дате встречи; резерв не считается, импортные записи входят. */
export async function attendanceByUserDay(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<AttendedDayRow[]> {
  return scoped(sql)<AttendedDayRow>`
    SELECT b.booked_by_user_id AS user_id, b.booking_date AS day,
           (count(*) FILTER (WHERE b.status = 'attended'))::int AS attended,
           (count(*) FILTER (WHERE b.status = 'no_show'))::int AS no_show
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve
       AND b.status IN ('attended','no_show')
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2`;
}

export interface PurchaseDayRow {
  userId: string;
  day: string;
  purchases: number;
  sumKzt: string;
}

/** Покупки: автору первой записи сделки, иначе владельцу сделки (D-261). Без автора и владельца — не попадают. */
export async function purchasesByUserDay(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<PurchaseDayRow[]> {
  return scoped(sql)<PurchaseDayRow>`
    WITH fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id)
    SELECT COALESCE(fb.booked_by_user_id, d.owner_user_id) AS user_id,
           to_char(to_timestamp(d.won_at / 1000.0) AT TIME ZONE ${a.timeZone}::text, 'YYYY-MM-DD') AS day,
           count(*)::int AS purchases, sum(d.amount_kzt)::text AS sum_kzt
      FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND COALESCE(fb.booked_by_user_id, d.owner_user_id) IS NOT NULL
       AND (${a.userIds}::text[] IS NULL OR COALESCE(fb.booked_by_user_id, d.owner_user_id) = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = d.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     GROUP BY 1, 2`;
}

/** Покупки периода без записи на мероприятие (оформлены напрямую, D-261): они в «Покупках», но не в цепочке «запись → явка». */
export async function purchasesWithoutBooking(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<number> {
  const rows = await scoped(sql)<{ n: number }>`
    SELECT count(*)::int AS n
      FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND d.owner_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.space_id = d.space_id)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}`;
  return rows[0]?.n ?? 0;
}

export interface SkipDayRow {
  userId: string;
  day: string;
  skips: number;
}

/** Пропуски по сотруднику и дню (skips_day_idx). Фильтра по источнику нет: у пропуска клиента не берём. */
export async function skipsByUserDay(sql: Sql, a: PeriodArgs): Promise<SkipDayRow[]> {
  return sql<SkipDayRow>`
    SELECT sk.user_id, sk.day, count(*)::int AS skips
      FROM skips sk
     WHERE sk.space_id = ${a.spaceId} AND sk.day BETWEEN ${a.from}::text AND ${a.to}::text
       AND (${a.userIds}::text[] IS NULL OR sk.user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s
                                              WHERE s.client_id = (SELECT c.client_id FROM cards c WHERE c.id = sk.card_id)
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
     GROUP BY 1, 2`;
}

// ---------------------------------------------------------------------------
// Воронка по источникам
// ---------------------------------------------------------------------------

export interface SourceStepRow {
  /** Ключ источника; '' — у клиента нет источника. */
  src: string;
  step: 'issued' | 'connected' | 'lpr' | 'booked' | 'attended' | 'purchased';
  n: number;
}

/** Шесть шагов воронки, сгруппированных по первому источнику клиента (client_sources_client_idx). Один запрос. */
export async function funnelBySource(viewer: Viewer, sql: Sql, a: PeriodArgs & { connectedKinds: readonly string[]; issueKinds: readonly string[] }): Promise<SourceStepRow[]> {
  return scoped(sql)<SourceStepRow>`
    WITH fs AS (
      -- первый источник клиента один раз, а не подзапросом на каждую строку шага (docs/ops/load-q1c.md)
      SELECT DISTINCT ON (s.client_id) s.client_id, CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END AS src
        FROM client_sources s ORDER BY s.client_id, s.first_seen_at, s.id),
    f AS (
      SELECT DISTINCT ON (ca.card_id) ca.card_id, ca.client_id, ca.user_id, ca.occurred_at
        FROM calls ca
       WHERE ca.space_id = ${a.spaceId} AND ca.lpr = 'yes' AND ca.applied = 'applied' AND ca.user_id IS NOT NULL
         AND ${scopeSql(viewer, 'call', 'card.read')}
       ORDER BY ca.card_id, ca.occurred_at, ca.id),
    fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id)
    SELECT COALESCE(fs.src, '') AS src,
           'issued' AS step, count(DISTINCT al.card_id)::int AS n
      FROM assign_log al
      LEFT JOIN cards ic ON ic.id = al.card_id
      LEFT JOIN fs ON fs.client_id = ic.client_id
     WHERE al.space_id = ${a.spaceId} AND al.day BETWEEN ${a.from}::text AND ${a.to}::text AND al.to_user_id IS NOT NULL
       AND al.kind = ANY(${[...a.issueKinds]}::text[])
       AND (${a.userIds}::text[] IS NULL OR al.to_user_id = ANY(${a.userIds}::text[]))
     GROUP BY 1
    UNION ALL
    SELECT COALESCE(fs.src, ''),
           'connected', count(*)::int
      FROM calls ca
      LEFT JOIN fs ON fs.client_id = ca.client_id
     WHERE ca.space_id = ${a.spaceId} AND ca.user_id IS NOT NULL AND ca.via <> 'import'
       AND ca.occurred_at >= ${a.fromMs}::bigint AND ca.occurred_at < ${a.toMs}::bigint
       AND ca.via <> 'board' AND ca.outcome_kind = ANY(${[...a.connectedKinds]}::text[])
       AND (${a.userIds}::text[] IS NULL OR ca.user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'call', 'card.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE(fs.src, ''),
           'lpr', count(*)::int
      FROM f
      LEFT JOIN fs ON fs.client_id = f.client_id
     WHERE f.occurred_at >= ${a.fromMs}::bigint AND f.occurred_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR f.user_id = ANY(${a.userIds}::text[]))
     GROUP BY 1
    UNION ALL
    SELECT COALESCE(fs.src, ''),
           'booked', count(*)::int
      FROM bookings b
      LEFT JOIN fs ON fs.client_id = b.client_id
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND b.created_at >= ${a.fromMs}::bigint AND b.created_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE(fs.src, ''),
           'attended', count(*)::int
      FROM bookings b
      LEFT JOIN fs ON fs.client_id = b.client_id
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve AND b.status = 'attended'
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE(fs.src, ''),
           'purchased', count(*)::int
      FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
      LEFT JOIN fs ON fs.client_id = d.client_id
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND COALESCE(fb.booked_by_user_id, d.owner_user_id) IS NOT NULL
       AND (${a.userIds}::text[] IS NULL OR COALESCE(fb.booked_by_user_id, d.owner_user_id) = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     GROUP BY 1`;
}

export interface FunnelKindStepRow {
  /** userId (по операторам) или ключ источника ('' — без источника). */
  key: string;
  kind: 'group' | 'individual';
  step: 'booked' | 'attended';
  n: number;
}

/** Шаги «запись» и «явка» по видам записи и автору (D-344): те же условия, что у bookedByUserDay и attendanceByUserDay. */
export async function funnelKindsByUser(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<FunnelKindStepRow[]> {
  return scoped(sql)<FunnelKindStepRow>`
    SELECT b.booked_by_user_id AS key, b.kind, 'booked' AS step, count(*)::int AS n
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND b.created_at >= ${a.fromMs}::bigint AND b.created_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2
    UNION ALL
    SELECT b.booked_by_user_id, b.kind, 'attended', count(*)::int
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve AND b.status = 'attended'
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2`;
}

/** То же по первому источнику клиента (как funnelBySource: без фильтра по ключу источника). */
export async function funnelKindsBySource(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<FunnelKindStepRow[]> {
  return scoped(sql)<FunnelKindStepRow>`
    WITH fs AS (
      SELECT DISTINCT ON (s.client_id) s.client_id, CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END AS src
        FROM client_sources s ORDER BY s.client_id, s.first_seen_at, s.id)
    SELECT COALESCE(fs.src, '') AS key, b.kind, 'booked' AS step, count(*)::int AS n
      FROM bookings b LEFT JOIN fs ON fs.client_id = b.client_id
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND b.created_at >= ${a.fromMs}::bigint AND b.created_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2
    UNION ALL
    SELECT COALESCE(fs.src, ''), b.kind, 'attended', count(*)::int
      FROM bookings b LEFT JOIN fs ON fs.client_id = b.client_id
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve AND b.status = 'attended'
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1, 2`;
}

// ---------------------------------------------------------------------------
// Выручка
// ---------------------------------------------------------------------------

export interface RevenueSqlRow {
  serviceTypeKey: string;
  purchases: number;
  sumKzt: string;
  firstPurchases: number;
  firstSumKzt: string;
}

/** Выручка по типам услуг; «первая» покупка — первая выигранная сделка клиента по (won_at, id) во всём пространстве. */
export async function revenueByServiceType(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<RevenueSqlRow[]> {
  return scoped(sql)<RevenueSqlRow>`
    WITH fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id),
    w AS (
      SELECT d.service_type_key, d.amount_kzt, d.won_at, d.client_id,
             COALESCE(fb.booked_by_user_id, d.owner_user_id) AS author,
             row_number() OVER (PARTITION BY d.client_id ORDER BY d.won_at, d.id) AS n
        FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
       WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND ${scopeSql(viewer, 'deal', 'deal.read')})
    SELECT w.service_type_key, count(*)::int AS purchases, sum(w.amount_kzt)::text AS sum_kzt,
           (count(*) FILTER (WHERE w.n = 1))::int AS first_purchases,
           COALESCE(sum(w.amount_kzt) FILTER (WHERE w.n = 1), 0)::text AS first_sum_kzt
      FROM w
     WHERE w.won_at >= ${a.fromMs}::bigint AND w.won_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR w.author = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = w.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
     GROUP BY 1`;
}

// ---------------------------------------------------------------------------
// Записи и явка
// ---------------------------------------------------------------------------

export interface AttendanceSqlRow {
  grp: string;
  booked: number;
  attended: number;
  noShow: number;
  unmarked: number;
  cancelled: number;
}

/** Записи по дате встречи без резерва; ключ группы — тип события, консультант ('' — серые) или автор записи. */
export async function attendanceGroups(
  viewer: Viewer,
  sql: Sql,
  a: PeriodArgs & { by: 'event_type' | 'consultant' | 'author'; now: number },
): Promise<AttendanceSqlRow[]> {
  return scoped(sql)<AttendanceSqlRow>`
    SELECT CASE ${a.by}::text WHEN 'event_type' THEN b.event_type_key WHEN 'consultant' THEN COALESCE(r.user_id, '')
                              ELSE COALESCE(b.booked_by_user_id, '') END AS grp,
           (count(*) FILTER (WHERE b.status IN ('registered','confirmed','attended','no_show')))::int AS booked,
           (count(*) FILTER (WHERE b.status = 'attended'))::int AS attended,
           (count(*) FILTER (WHERE b.status = 'no_show'))::int AS no_show,
           (count(*) FILTER (WHERE b.status IN ('registered','confirmed') AND b.starts_at < ${a.now}::bigint))::int AS unmarked,
           (count(*) FILTER (WHERE b.status = 'cancelled' AND b.cancel_reason <> 'operator_error'))::int AS cancelled
      FROM bookings b LEFT JOIN resources r ON r.id = b.resource_id
     WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve
       AND b.status IN ('registered','confirmed','attended','no_show','cancelled')
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1`;
}

export interface AttendancePurchaseRow {
  grp: string;
  dealId: string;
}

/** Выигранные за период сделки и ключи групп их живых записей (различные пары). Строк — по числу сделок. */
export async function attendancePurchases(
  viewer: Viewer,
  sql: Sql,
  a: PeriodArgs & { by: 'event_type' | 'consultant' | 'author' },
): Promise<AttendancePurchaseRow[]> {
  return scoped(sql)<AttendancePurchaseRow>`
    SELECT DISTINCT CASE ${a.by}::text WHEN 'event_type' THEN b.event_type_key WHEN 'consultant' THEN COALESCE(r.user_id, '')
                                       ELSE COALESCE(b.booked_by_user_id, '') END AS grp,
           d.id AS deal_id
      FROM deals d
      JOIN bookings b ON b.deal_id = d.id AND NOT b.is_reserve AND b.status IN ('registered','confirmed','attended','no_show')
      LEFT JOIN resources r ON r.id = b.resource_id
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = d.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}`;
}

// ---------------------------------------------------------------------------
// Причины
// ---------------------------------------------------------------------------

export interface ReasonSqlRow {
  grp: string;
  reasonCode: string;
  n: number;
}

/**
 * Причины за период. Группы: итоги «Перезвонить / не интересно / не целевой / не звонить» (`calls.reason_code`, пустая
 * причина — «без причины»), списанные карточки (`cards.close_reason_code`: ручное и системное списание), потерянные
 * сделки и неявки по виду мероприятия (D-344).
 */
export async function reasonCounts(viewer: Viewer, sql: Sql, a: PeriodArgs & { closingKinds: readonly string[] }): Promise<ReasonSqlRow[]> {
  return scoped(sql)<ReasonSqlRow>`
    SELECT ca.outcome_kind AS grp, ca.reason_code, count(*)::int AS n
      FROM calls ca
     WHERE ca.space_id = ${a.spaceId} AND ca.via <> 'import' AND ca.applied = 'applied'
       AND ca.outcome_kind = ANY(${[...a.closingKinds]}::text[])
       AND ca.occurred_at >= ${a.fromMs}::bigint AND ca.occurred_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR ca.user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = ca.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'call', 'card.read')}
     GROUP BY 1, 2
    UNION ALL
    SELECT 'written_off', c.close_reason_code, count(*)::int
      FROM cards c
     WHERE c.space_id = ${a.spaceId} AND c.state = 'written_off'
       AND c.closed_at >= ${a.fromMs}::bigint AND c.closed_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR c.owner_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = c.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'card', 'card.read')}
     GROUP BY 2
    UNION ALL
    SELECT 'deal_lost', d.lost_reason_code, count(*)::int
      FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.status = 'lost' AND d.lost_at >= ${a.fromMs}::bigint AND d.lost_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR d.owner_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = d.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     GROUP BY 2
    UNION ALL
    SELECT 'no_show', b.event_type_key, count(*)::int
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve AND b.status = 'no_show'
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 2`;
}

// ---------------------------------------------------------------------------
// Сотрудники
// ---------------------------------------------------------------------------

/** Имена сотрудников по id: один запрос (users — служебная таблица). */
export async function userNames(sql: Sql, ids: readonly string[]): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return sql<{ id: string; name: string }>`SELECT id, name FROM users WHERE id = ANY(${[...ids]}::text[])`;
}

/** Консультанты пространства (ресурсы записи) с именами: для фильтра списка явки. */
export async function consultantNames(sql: Sql, spaceId: string): Promise<{ userId: string; name: string }[]> {
  return sql<{ userId: string; name: string }>`
    SELECT r.user_id, u.name FROM resources r JOIN users u ON u.id = r.user_id
     WHERE r.space_id = ${spaceId} ORDER BY u.name, r.user_id`;
}

// ---------------------------------------------------------------------------
// Явка — список
// ---------------------------------------------------------------------------

export interface AttendanceListSqlRow {
  bookingId: string;
  date: string;
  startTime: string;
  startsAt: string;
  eventTypeKey: string;
  clientId: string;
  clientName: string;
  bookedByUserId: string | null;
  bookedByName: string | null;
  status: string;
  markedByUserId: string | null;
  markedByName: string | null;
  consultantUserId: string | null;
  consultantName: string | null;
  purchaseSumKzt: string | null;
}

export interface AttendanceListArgs extends PeriodArgs {
  now: number;
  eventType: string | null;
  status: string | null;
  consultant: string | null;
  /** Курсор: (starts_at, id) последней показанной строки; null — с начала. */
  after: { startsAt: number; id: string } | null;
  /** Строк на странице плюс одна, чтобы узнать, есть ли следующая. */
  limit: number;
}

/**
 * Поимённый список записей по дате встречи (резерв и «ошибка оператора» не показываются), новые сверху.
 * Статус «не отмечено» — дата прошла, явка не отмечена. Отметчик явки — автор последней записи истории со статусом
 * «пришёл / не пришёл»; система (автоотметка) — без автора. Покупка — выигранная сделка той же записи.
 */
export async function attendanceListRows(viewer: Viewer, sql: Sql, a: AttendanceListArgs): Promise<AttendanceListSqlRow[]> {
  return scoped(sql)<AttendanceListSqlRow>`
    WITH l AS (
      SELECT b.id AS booking_id, b.booking_date AS date, b.start_time, b.starts_at, b.event_type_key,
             b.client_id, cl.name AS client_name, b.booked_by_user_id, bu.name AS booked_by_name,
             CASE WHEN b.status = 'cancelled' THEN 'cancelled'
                  WHEN b.status = 'attended' THEN 'attended'
                  WHEN b.status = 'no_show' THEN 'no_show'
                  WHEN b.starts_at < ${a.now}::bigint THEN 'unmarked'
                  ELSE 'planned' END AS status,
             mk.actor_id AS marked_by_user_id, mu.name AS marked_by_name,
             r.user_id AS consultant_user_id, cu.name AS consultant_name,
             d.amount_kzt::text AS purchase_sum_kzt
        FROM bookings b
        JOIN clients cl ON cl.id = b.client_id AND ${scopeSql(viewer, 'client', 'client.read')}
        LEFT JOIN users bu ON bu.id = b.booked_by_user_id
        LEFT JOIN resources r ON r.id = b.resource_id
        LEFT JOIN users cu ON cu.id = r.user_id
        LEFT JOIN deals d ON d.id = b.deal_id AND d.status = 'won' AND ${scopeSql(viewer, 'deal', 'deal.read')}
        LEFT JOIN LATERAL (
          SELECT h.actor_id FROM booking_history h
           WHERE h.booking_id = b.id AND h.action = 'status' AND h.to_status IN ('attended','no_show')
           ORDER BY h.created_at DESC, h.id DESC LIMIT 1) mk ON b.status IN ('attended','no_show')
        LEFT JOIN users mu ON mu.id = mk.actor_id
       WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve
         AND b.status IN ('registered','confirmed','attended','no_show','cancelled')
         AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
         AND (${a.eventType}::text IS NULL OR b.event_type_key = ${a.eventType}::text)
         AND (${a.consultant}::text IS NULL OR r.user_id = ${a.consultant}::text)
         AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
         AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                                 FROM client_sources s WHERE s.client_id = b.client_id
                                                ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
         AND (${a.after?.startsAt ?? null}::bigint IS NULL OR (b.starts_at, b.id) < (${a.after?.startsAt ?? null}::bigint, ${a.after?.id ?? null}::text))
         AND ${scopeSql(viewer, 'booking', 'booking.read')})
    SELECT * FROM l
     WHERE ${a.status}::text IS NULL OR l.status = ${a.status}::text
     ORDER BY l.starts_at DESC, l.booking_id DESC
     LIMIT ${a.limit}`;
}

/**
 * Сколько записей в каждом статусе при тех же фильтрах, что у списка, но без статуса и курсора: числа для чипов над
 * таблицей. Набор записей и охват — как в `attendanceListRows`.
 */
export async function attendanceListCounts(viewer: Viewer, sql: Sql, a: Omit<AttendanceListArgs, 'status' | 'after' | 'limit'>): Promise<{ status: string; n: number }[]> {
  return scoped(sql)<{ status: string; n: number }>`
    SELECT CASE WHEN b.status = 'cancelled' THEN 'cancelled'
                WHEN b.status = 'attended' THEN 'attended'
                WHEN b.status = 'no_show' THEN 'no_show'
                WHEN b.starts_at < ${a.now}::bigint THEN 'unmarked'
                ELSE 'planned' END AS status,
           count(*)::int AS n
      FROM bookings b
      JOIN clients cl ON cl.id = b.client_id AND ${scopeSql(viewer, 'client', 'client.read')}
      LEFT JOIN resources r ON r.id = b.resource_id
     WHERE b.space_id = ${a.spaceId} AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve
       AND b.status IN ('registered','confirmed','attended','no_show','cancelled')
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND (${a.eventType}::text IS NULL OR b.event_type_key = ${a.eventType}::text)
       AND (${a.consultant}::text IS NULL OR r.user_id = ${a.consultant}::text)
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND (${a.sourceKey}::text IS NULL OR (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END
                                               FROM client_sources s WHERE s.client_id = b.client_id
                                              ORDER BY s.first_seen_at, s.id LIMIT 1) = ${a.sourceKey}::text)
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1`;
}
