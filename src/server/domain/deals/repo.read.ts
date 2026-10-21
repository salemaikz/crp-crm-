// SQL чтения сделок (B6): страница сделки, её история, записи и передача, форма покупки по карточке.
// Каждая строка сделки, карточки, ленты и записи — через scopeSql; передача — только id, статус и ключ отдела.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { calling } from '@crm/core';
import type { BookingRow } from '@/server/domain/booking/repo';
import type { Sql } from '@/server/platform/db';
import type { DealFullRow } from './repo.purchase';

export interface DealPageRow extends DealFullRow {
  clientName: string;
  ownerName: string | null;
  canEdit: boolean;
  canPurchase: boolean;
  canMoveBack: boolean;
}

/** Сделка в охвате `deal.read` с именами и тем, что зритель может с ней сделать (по охвату, не по роли). */
export async function findDealPageRow(viewer: Viewer, sql: Sql, dealId: string): Promise<DealPageRow | null> {
  const rows = await scoped(sql)<DealPageRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at,
           cl.name AS client_name, ou.name AS owner_name,
           (${scopeSql(viewer, 'deal', 'deal.edit')}) AS can_edit,
           (${scopeSql(viewer, 'deal', 'deal.purchase')}) AS can_purchase,
           (${scopeSql(viewer, 'deal', 'deal.move_back')}) AS can_move_back
      FROM deals d JOIN clients cl ON cl.id = d.client_id LEFT JOIN users ou ON ou.id = d.owner_user_id
     WHERE d.id = ${dealId} AND ${scopeSql(viewer, 'deal', 'deal.read')}`;
  return rows[0] ?? null;
}

export interface DealHistoryRow {
  id: string;
  kind: string;
  at: number;
  actorName: string | null;
  data: Record<string, unknown>;
}

/** История сделки: события ленты с `deal_id` в охвате ленты (≤ 100, новые сверху). */
export async function listDealHistory(viewer: Viewer, sql: Sql, dealId: string): Promise<DealHistoryRow[]> {
  return scoped(sql)<DealHistoryRow>`
    SELECT ev.id, ev.kind, ev.at, u.name AS actor_name, ev.data
      FROM client_events ev LEFT JOIN users u ON u.id = ev.actor_id
     WHERE ev.deal_id = ${dealId} AND ${scopeSql(viewer, 'client_event', 'card.read')}
     ORDER BY ev.at DESC, ev.id DESC LIMIT 100`;
}

/** Записи сделки в охвате записи (≤ 50, поздние сверху). */
export async function listDealBookings(viewer: Viewer, sql: Sql, dealId: string): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.* FROM bookings b WHERE b.deal_id = ${dealId} AND ${scopeSql(viewer, 'booking', 'booking.read')}
     ORDER BY b.starts_at DESC, b.id LIMIT 50`;
}

/** Передача по сделке (сделка уже прочитана в охвате): только статус и ключ отдела, без ПДн. */
export async function findDealHandoff(sql: Sql, dealId: string): Promise<{ id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled'; teamKey: string } | null> {
  const rows = await sql<{ id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled'; teamKey: string }>`
    SELECT h.id, h.status, t.key AS team_key FROM handoffs h JOIN teams t ON t.id = h.team_id WHERE h.deal_id = ${dealId}`;
  return rows[0] ?? null;
}

export interface PurchaseCardRow {
  id: string;
  clientId: string;
  spaceId: string;
  state: calling.CardState;
  clientName: string;
}

/** Карточка для формы покупки в охвате `deal.purchase`. */
export async function findCardForPurchase(viewer: Viewer, sql: Sql, cardId: string): Promise<PurchaseCardRow | null> {
  const rows = await scoped(sql)<PurchaseCardRow>`
    SELECT c.id, c.client_id, c.space_id, c.state, cl.name AS client_name
      FROM cards c JOIN clients cl ON cl.id = c.client_id
     WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', 'deal.purchase')}`;
  return rows[0] ?? null;
}

export interface OpenDealLite {
  id: string;
  pipelineKey: string;
  stageKey: string;
  version: number;
  createdAt: number;
}

/** Открытые сделки карточки в охвате `deal.purchase` (старые первыми). */
export async function listOpenDealsOfCard(viewer: Viewer, sql: Sql, cardId: string): Promise<OpenDealLite[]> {
  return scoped(sql)<OpenDealLite>`
    SELECT d.id, d.pipeline_key, d.stage_key, d.version, d.created_at FROM deals d
     WHERE d.card_id = ${cardId} AND d.status = 'open' AND ${scopeSql(viewer, 'deal', 'deal.purchase')}
     ORDER BY d.created_at, d.id LIMIT 50`;
}
