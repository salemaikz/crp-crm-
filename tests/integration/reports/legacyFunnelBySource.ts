// Эталон для теста: прежний запрос воронки по источникам (коррелированный подзапрос «первый источник» на строку).
// Новый `funnelBySource` обязан давать то же самое; файл не используется приложением.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import type { PeriodArgs, SourceStepRow } from '@/server/domain/reports/periodRepo';

export async function legacyFunnelBySource(viewer: Viewer, sql: Sql, a: PeriodArgs & { connectedKinds: readonly string[]; issueKinds: readonly string[] }): Promise<SourceStepRow[]> {
  return scoped(sql)<SourceStepRow>`
    WITH f AS (
      SELECT DISTINCT ON (ca.card_id) ca.card_id, ca.client_id, ca.user_id, ca.occurred_at
        FROM calls ca
       WHERE ca.space_id = ${a.spaceId} AND ca.lpr = 'yes' AND ca.applied = 'applied' AND ca.user_id IS NOT NULL
         AND ${scopeSql(viewer, 'call', 'card.read')}
       ORDER BY ca.card_id, ca.occurred_at, ca.id),
    fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id)
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = (SELECT c.client_id FROM cards c WHERE c.id = al.card_id)
                      ORDER BY s.first_seen_at, s.id LIMIT 1), '') AS src,
           'issued' AS step, count(DISTINCT al.card_id)::int AS n
      FROM assign_log al
     WHERE al.space_id = ${a.spaceId} AND al.day BETWEEN ${a.from}::text AND ${a.to}::text AND al.to_user_id IS NOT NULL
       AND al.kind = ANY(${[...a.issueKinds]}::text[])
       AND (${a.userIds}::text[] IS NULL OR al.to_user_id = ANY(${a.userIds}::text[]))
     GROUP BY 1
    UNION ALL
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = ca.client_id ORDER BY s.first_seen_at, s.id LIMIT 1), ''),
           'connected', count(*)::int
      FROM calls ca
     WHERE ca.space_id = ${a.spaceId} AND ca.user_id IS NOT NULL AND ca.via <> 'import'
       AND ca.occurred_at >= ${a.fromMs}::bigint AND ca.occurred_at < ${a.toMs}::bigint
       AND ca.outcome_kind = ANY(${[...a.connectedKinds]}::text[])
       AND (${a.userIds}::text[] IS NULL OR ca.user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'call', 'card.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = f.client_id ORDER BY s.first_seen_at, s.id LIMIT 1), ''),
           'lpr', count(*)::int
      FROM f
     WHERE f.occurred_at >= ${a.fromMs}::bigint AND f.occurred_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR f.user_id = ANY(${a.userIds}::text[]))
     GROUP BY 1
    UNION ALL
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = b.client_id ORDER BY s.first_seen_at, s.id LIMIT 1), ''),
           'booked', count(*)::int
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
       AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
       AND b.created_at >= ${a.fromMs}::bigint AND b.created_at < ${a.toMs}::bigint
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = b.client_id ORDER BY s.first_seen_at, s.id LIMIT 1), ''),
           'attended', count(*)::int
      FROM bookings b
     WHERE b.space_id = ${a.spaceId} AND b.booked_by_user_id IS NOT NULL
       AND b.booking_date BETWEEN ${a.from}::text AND ${a.to}::text AND NOT b.is_reserve AND b.status = 'attended'
       AND (${a.userIds}::text[] IS NULL OR b.booked_by_user_id = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'booking', 'booking.read')}
     GROUP BY 1
    UNION ALL
    SELECT COALESCE((SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
                      WHERE s.client_id = d.client_id ORDER BY s.first_seen_at, s.id LIMIT 1), ''),
           'purchased', count(*)::int
      FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND COALESCE(fb.booked_by_user_id, d.owner_user_id) IS NOT NULL
       AND (${a.userIds}::text[] IS NULL OR COALESCE(fb.booked_by_user_id, d.owner_user_id) = ANY(${a.userIds}::text[]))
       AND ${scopeSql(viewer, 'deal', 'deal.read')}
     GROUP BY 1`;
}
