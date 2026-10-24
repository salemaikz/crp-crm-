// SQL «Моих покупок» (pipeline-v2 §9.5): выигранные сделки по заслуге. Предикат «заслуга = я» — автор первой записи
// сделки (`bookings.booked_by_user_id`, как в отчёте «Покупки оператора»), а не текущий владелец карточки: после
// передачи карточки продажа остаётся у автора. Название клиента — только если карточка сейчас в охвате `card.read`.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export interface MineRow {
  dealId: string;
  wonAt: number;
  serviceTypeKey: string | null;
  /** Вариант услуги (D-357); '' — без варианта. */
  serviceVariantKey: string | null;
  amountKzt: string | null;
  clientId: string | null;
  clientName: string | null;
  clientVisible: boolean;
}

/** Выигранные сделки зрителя в окне [fromMs, toMs), новые сверху. Имя и id клиента — только при охвате карточки. */
export async function listMyPurchases(viewer: Viewer, sql: Sql, a: { spaceId: string; fromMs: number; toMs: number; limit: number; after?: { wonAt: number; id: string } | null }): Promise<MineRow[]> {
  return scoped(sql)<MineRow>`
    WITH fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id)
    SELECT d.id AS deal_id, d.won_at, d.service_type_key, d.service_variant_key, d.amount_kzt::text AS amount_kzt,
           CASE WHEN vis.ok THEN d.client_id END AS client_id,
           CASE WHEN vis.ok THEN cl.name END AS client_name,
           vis.ok AS client_visible
      FROM deals d
      LEFT JOIN fb ON fb.deal_id = d.id
      JOIN clients cl ON cl.id = d.client_id
      LEFT JOIN cards c ON c.id = d.card_id
      CROSS JOIN LATERAL (SELECT (c.id IS NOT NULL AND ${scopeSql(viewer, 'card', 'card.read')}) AS ok) vis
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND COALESCE(fb.booked_by_user_id, d.owner_user_id) = ${viewer.userId}
       AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint
       AND (${a.after?.id ?? null}::text IS NULL OR d.won_at < ${a.after?.wonAt ?? 0}::bigint
            OR (d.won_at = ${a.after?.wonAt ?? 0}::bigint AND d.id > ${a.after?.id ?? ''}::text))
     ORDER BY d.won_at DESC, d.id
     LIMIT ${a.limit}`;
}

/** Итог окна для шапки колонки «Покупка»: число и сумма засчитанных сделок. */
export async function sumMyPurchases(viewer: Viewer, sql: Sql, a: { spaceId: string; fromMs: number; toMs: number }): Promise<{ count: number; sumKzt: string }> {
  const rows = await sql<{ count: number; sumKzt: string }>`
    WITH fb AS (
      SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
        FROM bookings b WHERE b.space_id = ${a.spaceId} AND b.deal_id IS NOT NULL
       ORDER BY b.deal_id, b.created_at, b.id)
    SELECT count(*)::int AS count, COALESCE(sum(d.amount_kzt), 0)::text AS sum_kzt
      FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
     WHERE d.space_id = ${a.spaceId} AND d.status = 'won' AND COALESCE(fb.booked_by_user_id, d.owner_user_id) = ${viewer.userId}
       AND d.won_at >= ${a.fromMs}::bigint AND d.won_at < ${a.toMs}::bigint`;
  return rows[0] ?? { count: 0, sumKzt: '0' };
}
