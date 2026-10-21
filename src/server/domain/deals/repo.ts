// SQL сделок в объёме записи (B2): открыть, двинуть вперёд, пометить «перезаписать», закрыть по ошибке ввода.
// Остальное — B6. Все запросы идут от заблокированной карточки (её охват проверил вызывающий), поэтому
// сделка выбирается по `card_id`/id, а не через scopeSql: у дежурного и системы карточки в охвате нет.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';

export interface DealRow {
  id: string;
  spaceId: string;
  pipelineKey: string;
  stageKey: string;
  status: 'open' | 'won' | 'lost';
  clientId: string;
  cardId: string;
  requestId: string | null;
}


export async function findDealByRequestId(sql: Sql, requestId: string): Promise<DealRow | null> {
  const rows = await sql<DealRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.request_id
      FROM deals d WHERE d.request_id = ${requestId}`;
  return rows[0] ?? null;
}

export async function findDealById(sql: Sql, id: string): Promise<DealRow | null> {
  const rows = await sql<DealRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.request_id
      FROM deals d WHERE d.id = ${id} FOR UPDATE OF d`;
  return rows[0] ?? null;
}

/** Все открытые сделки клиента в пространстве (старейшие первыми), с блокировкой строк. */
export async function listOpenDealsOfClient(sql: Sql, spaceId: string, clientId: string): Promise<DealRow[]> {
  return sql<DealRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.request_id
      FROM deals d WHERE d.client_id = ${clientId} AND d.space_id = ${spaceId} AND d.status = 'open'
     ORDER BY d.created_at, d.id FOR UPDATE OF d`;
}

/** Открытая сделка карточки в воронке (старейшая). */
export async function findOpenDealId(sql: Sql, cardId: string, pipelineKey: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    SELECT d.id FROM deals d
     WHERE d.card_id = ${cardId} AND d.pipeline_key = ${pipelineKey} AND d.status = 'open'
     ORDER BY d.created_at, d.id LIMIT 1`;
  return rows[0]?.id ?? null;
}

export async function insertDeal(
  sql: Sql,
  d: { spaceId: string; pipelineKey: string; stageKey: string; clientId: string; cardId: string; ownerUserId: string | null; requestId: string; createdBy: string | null; at: number },
): Promise<string | null> {
  const id = newId();
  const rows = await sql<{ id: string }>`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at,
                       request_id, version, created_by, created_at, updated_at)
    VALUES (${id}, ${d.spaceId}, ${d.pipelineKey}, ${d.stageKey}, 'open', ${d.clientId}, ${d.cardId}, ${d.ownerUserId}, ${d.at},
            ${d.requestId}, 0, ${d.createdBy}, ${d.at}, ${d.at})
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

export async function setDealStage(sql: Sql, id: string, stageKey: string, at: number): Promise<void> {
  await sql`UPDATE deals d SET stage_key = ${stageKey}, stage_changed_at = ${at}, version = d.version + 1, updated_at = ${at} WHERE d.id = ${id}`;
}

export async function loseDeal(sql: Sql, id: string, a: { stageKey: string; reasonCode: string; at: number }): Promise<void> {
  await sql`
    UPDATE deals d SET status = 'lost', stage_key = ${a.stageKey}, lost_at = ${a.at}, lost_reason_code = ${a.reasonCode},
                       stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${id} AND d.status = 'open'`;
}

export async function dealIdOfBooking(sql: Sql, bookingId: string): Promise<string | null> {
  const rows = await sql<{ dealId: string | null }>`SELECT b.deal_id FROM bookings b WHERE b.id = ${bookingId}`;
  return rows[0]?.dealId ?? null;
}

/** Значок «перезаписать» на сделке записи; без сделки — ничего. */
export async function setNeedsRebook(sql: Sql, bookingId: string, value: boolean, at: number): Promise<void> {
  await sql`
    UPDATE deals d SET needs_rebook = ${value}, updated_at = ${at}
     WHERE d.id = (SELECT b.deal_id FROM bookings b WHERE b.id = ${bookingId}) AND d.needs_rebook <> ${value}`;
}

/** Событие ленты клиента по сделке: только коды и id (D-020). */
export async function insertDealFeed(
  sql: Sql,
  e: { clientId: string; spaceId: string; dealId: string; kind: 'deal.created' | 'deal.stage' | 'deal.lost'; actorId: string | null; at: number; data: Record<string, string | number | boolean | null> },
): Promise<void> {
  await sql`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'deal', ${e.dealId}, ${jsonParam(e.data)})`;
}


export interface DealStageRow extends DealRow {
  version: number;
  /** Поля сделки — для требований этапа. */
  custom: Record<string, unknown> | null;
}

/** Сделка под блокировкой для ручной смены этапа: охват `deal.edit` (консультанту — по отношению, в окне). */
export async function lockDealForStage(viewer: Viewer, sql: Sql, id: string): Promise<DealStageRow | null> {
  const rows = await scoped(sql)<DealStageRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.request_id, d.version, d.custom
      FROM deals d WHERE d.id = ${id} AND ${scopeSql(viewer, 'deal', 'deal.edit')} FOR UPDATE OF d`;
  return rows[0] ?? null;
}

/** Смена этапа открытой сделки с проверкой версии и охвата; не совпало — false. */
export async function updateDealStageScoped(viewer: Viewer, sql: Sql, a: { id: string; version: number; stageKey: string; at: number }): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`
    UPDATE deals d SET stage_key = ${a.stageKey}, stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.version = ${a.version} AND d.status = 'open' AND ${scopeSql(viewer, 'deal', 'deal.edit')}
    RETURNING d.id`;
  return rows.length > 0;
}

/** Агрегат без строк сделок (число для тревоги), поэтому без охвата, как `countTaken` в записи. Сколько открытых сделок лежат на этапе не меньше срока (`stage_changed_at` не позже границы). */
export async function countStaleOnStage(
  sql: Sql,
  a: { spaceId: string; pipelineKey: string; stageKey: string; threshold: number },
): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM deals d
     WHERE d.space_id = ${a.spaceId} AND d.pipeline_key = ${a.pipelineKey} AND d.status = 'open' AND d.stage_key = ${a.stageKey}
       AND d.stage_changed_at <= ${a.threshold}`;
  return rows[0]?.n ?? 0;
}
