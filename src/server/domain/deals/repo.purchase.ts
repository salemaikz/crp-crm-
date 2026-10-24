// SQL покупки, её правки и отмены, ручного этапа и проигрыша, страницы сделки и формы покупки (B6,
// docs/deals-handoffs-design.md §5). Строки карточек и сделок для сотрудника — только через scopeSql; карточка,
// найденная через сделку в охвате, блокируется по id (охват сделки = охват её карточки, scope.ts).
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';
import type { LockedCard } from '@/server/domain/booking/types';
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type { DealStatus } from './types';

type DealPerm = Extract<Permission, 'deal.read' | 'deal.edit' | 'deal.purchase' | 'deal.move_back'>;

export interface DealFullRow {
  id: string;
  spaceId: string;
  pipelineKey: string;
  stageKey: string;
  status: DealStatus;
  clientId: string;
  cardId: string;
  ownerUserId: string | null;
  serviceTypeKey: string;
  amountKzt: number;
  wonAt: number | null;
  lostAt: number | null;
  lostReasonCode: string;
  needsRebook: boolean;
  stageChangedAt: number;
  custom: Record<string, unknown>;
  requestId: string | null;
  version: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Блокировки
// ---------------------------------------------------------------------------

/** Карточка под блокировкой в охвате `perm` (покупка: `deal.purchase` — консультанту по отношению, в окне). */
export async function lockCardScoped(viewer: Viewer, tx: Sql, cardId: string, perm: DealPerm): Promise<LockedCard | null> {
  const rows = await scoped(tx)<LockedCard>`
    SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
      FROM cards c WHERE c.id = ${cardId} AND ${scopeSql(viewer, 'card', perm)} FOR UPDATE OF c`;
  return rows[0] ?? null;
}

/** Карточка сделки по id под блокировкой: охват уже проверен по сделке. */
export async function lockCardById(tx: Sql, cardId: string): Promise<LockedCard | null> {
  const rows = await tx<LockedCard>`
    SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
      FROM cards c WHERE c.id = ${cardId} FOR UPDATE OF c`;
  return rows[0] ?? null;
}

/** Сделка в охвате `perm`: без блокировки — чтобы узнать карточку и взять блокировки по порядку (карточка → сделка). */
export async function findDealScoped(viewer: Viewer, tx: Sql, dealId: string, perm: DealPerm): Promise<DealFullRow | null> {
  const rows = await scoped(tx)<DealFullRow>`
    SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at FROM deals d WHERE d.id = ${dealId} AND ${scopeSql(viewer, 'deal', perm)}`;
  return rows[0] ?? null;
}

/** Сделка в охвате `perm` под блокировкой; `cardId` — ещё и сделка этой карточки. */
export async function lockDealScoped(viewer: Viewer, tx: Sql, a: { dealId: string; perm: DealPerm; cardId?: string }): Promise<DealFullRow | null> {
  const rows =
    a.cardId === undefined
      ? await scoped(tx)<DealFullRow>`
          SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at FROM deals d WHERE d.id = ${a.dealId} AND ${scopeSql(viewer, 'deal', a.perm)} FOR UPDATE OF d`
      : await scoped(tx)<DealFullRow>`
          SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at FROM deals d WHERE d.id = ${a.dealId} AND d.card_id = ${a.cardId} AND ${scopeSql(viewer, 'deal', a.perm)} FOR UPDATE OF d`;
  return rows[0] ?? null;
}

/** Сделка по id без охвата (исполнитель эффектов карточки: карточка заблокирована вызывающим). */
export async function lockDealById(tx: Sql, dealId: string): Promise<DealFullRow | null> {
  const rows = await tx<DealFullRow>`SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at FROM deals d WHERE d.id = ${dealId} FOR UPDATE OF d`;
  return rows[0] ?? null;
}

export async function findDealByRequest(tx: Sql, requestId: string): Promise<DealFullRow | null> {
  const rows = await tx<DealFullRow>`SELECT d.id, d.space_id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.needs_rebook, d.stage_changed_at, d.custom, d.request_id, d.version, d.created_at FROM deals d WHERE d.request_id = ${requestId}`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Лента: ключ повтора — client_events.id (D-248)
// ---------------------------------------------------------------------------

export interface FeedRow {
  kind: string;
  clientId: string;
  dealId: string | null;
  data: Record<string, unknown>;
}

export async function findFeedById(tx: Sql, id: string): Promise<FeedRow | null> {
  const rows = await tx<FeedRow>`SELECT e.kind, e.client_id, e.deal_id, e.data FROM client_events e WHERE e.id = ${id}`;
  return rows[0] ?? null;
}

/** Событие ленты по сделке с заданным id. Id уже занят — false (вызывающий отвечает `request_reused`). */
export async function insertDealFeedWithId(
  tx: Sql,
  e: { id: string; clientId: string; spaceId: string; dealId: string; kind: string; actorId: string | null; at: number; data: Record<string, string | number | boolean | null> },
): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${e.id}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'deal', ${e.dealId}, ${jsonParam(e.data)})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Этап до покупки — `data.fromStage` последнего `deal.won` сделки; нет события — `found: false`. */
export async function lastWonFromStage(tx: Sql, dealId: string): Promise<{ found: boolean; fromStage: string | null }> {
  const rows = await tx<{ fromStage: string | null }>`
    SELECT e.data->>'fromStage' AS from_stage FROM client_events e
     WHERE e.deal_id = ${dealId} AND e.kind = 'deal.won' ORDER BY e.at DESC, e.id DESC LIMIT 1`;
  return rows[0] ? { found: true, fromStage: rows[0].fromStage } : { found: false, fromStage: null };
}

// ---------------------------------------------------------------------------
// Запись покупки и её отмены. UPDATE без scopeSql — исключение D-302: строка сделки уже взята FOR UPDATE в этой
// транзакции (сервисом в охвате действия или исполнителем эффектов под блокировкой карточки); статус — токен правки.
// ---------------------------------------------------------------------------

/** Открытая сделка → выиграна. Только из `open`: 0 строк — false. */
export async function markDealWon(tx: Sql, a: { id: string; stageKey: string; serviceTypeKey: string; variantKey: string; amountKzt: number; wonAt: number; at: number }): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    UPDATE deals d SET status = 'won', stage_key = ${a.stageKey}, service_type_key = ${a.serviceTypeKey}, service_variant_key = ${a.variantKey}, amount_kzt = ${a.amountKzt},
                       won_at = ${a.wonAt}, stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.status = 'open'
    RETURNING d.id`;
  return rows.length > 0;
}

/** Новая сделка сразу выигранной (`request_id` = ключ покупки). Ключ занят — null. */
export async function insertWonDeal(
  tx: Sql,
  d: { spaceId: string; pipelineKey: string; stageKey: string; clientId: string; cardId: string; ownerUserId: string | null; serviceTypeKey: string; variantKey: string; amountKzt: number; wonAt: number; requestId: string; createdBy: string | null; at: number },
): Promise<string | null> {
  const id = newId();
  const rows = await tx<{ id: string }>`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, service_variant_key, amount_kzt, won_at,
                       stage_changed_at, request_id, version, created_by, created_at, updated_at)
    VALUES (${id}, ${d.spaceId}, ${d.pipelineKey}, ${d.stageKey}, 'won', ${d.clientId}, ${d.cardId}, ${d.ownerUserId}, ${d.serviceTypeKey}, ${d.variantKey},
            ${d.amountKzt}, ${d.wonAt}, ${d.at}, ${d.requestId}, 0, ${d.createdBy}, ${d.at}, ${d.at})
    ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/** Правка суммы и даты выигранной сделки по версии и охвату `deal.move_back`. */
export async function updatePurchaseScoped(viewer: Viewer, tx: Sql, a: { id: string; version: number; amountKzt: number; wonAt: number; variantKey?: string; at: number }): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE deals d SET amount_kzt = ${a.amountKzt}, service_variant_key = COALESCE(${a.variantKey ?? null}::text, d.service_variant_key), won_at = ${a.wonAt}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.version = ${a.version} AND d.status = 'won' AND ${scopeSql(viewer, 'deal', 'deal.move_back')}
    RETURNING d.id`;
  return rows.length > 0;
}

/** Выигранная → проигран (возврат денег или ошибка без прежнего этапа). Сумма и тип остаются для отчёта возвратов. */
export async function markWonDealLost(tx: Sql, a: { id: string; stageKey: string; reasonCode: string; at: number }): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    UPDATE deals d SET status = 'lost', stage_key = ${a.stageKey}, lost_at = ${a.at}, lost_reason_code = ${a.reasonCode},
                       stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.status = 'won'
    RETURNING d.id`;
  return rows.length > 0;
}

/** Выигранная → снова открыта на прежнем этапе (покупка была ошибкой ввода): сумма 0, тип пуст, даты покупки нет. */
export async function reopenWonDeal(tx: Sql, a: { id: string; stageKey: string; at: number }): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    UPDATE deals d SET status = 'open', stage_key = ${a.stageKey}, won_at = NULL, service_type_key = '', service_variant_key = '', amount_kzt = 0,
                       stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.status = 'won'
    RETURNING d.id`;
  return rows.length > 0;
}

/** Открытая → проиграна с причиной и текстом (текст — ПДн, в ленту не уходит), по версии и охвату `deal.edit`. */
export async function loseDealScoped(
  viewer: Viewer,
  tx: Sql,
  a: { id: string; version: number; stageKey: string; reasonCode: string; reasonText: string; at: number },
): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE deals d SET status = 'lost', stage_key = ${a.stageKey}, lost_at = ${a.at}, lost_reason_code = ${a.reasonCode},
                       lost_reason_text = ${a.reasonText}, stage_changed_at = ${a.at}, version = d.version + 1, updated_at = ${a.at}
     WHERE d.id = ${a.id} AND d.version = ${a.version} AND d.status = 'open' AND ${scopeSql(viewer, 'deal', 'deal.edit')}
    RETURNING d.id`;
  return rows.length > 0;
}

/** Есть ли у клиента в пространстве другая сделка в статусе `status` (кроме `exceptId`). */
export async function hasOtherDeal(tx: Sql, a: { spaceId: string; clientId: string; status: DealStatus; exceptId: string | null }): Promise<boolean> {
  const rows = await tx<{ hit: boolean }>`
    SELECT EXISTS (SELECT 1 FROM deals d WHERE d.space_id = ${a.spaceId} AND d.client_id = ${a.clientId} AND d.status = ${a.status}
                     AND d.id IS DISTINCT FROM ${a.exceptId}) AS hit`;
  return rows[0]?.hit ?? false;
}

/** Комментарий к отмене покупки — заметка по сделке (как C8) и событие ленты без текста. */
export async function insertDealNote(tx: Sql, n: { clientId: string; spaceId: string; dealId: string; authorId: string; body: string; at: number }): Promise<string> {
  const id = newId();
  await tx`
    INSERT INTO notes (id, client_id, space_id, deal_id, author_id, body, pinned, created_at)
    VALUES (${id}, ${n.clientId}, ${n.spaceId}, ${n.dealId}, ${n.authorId}, ${n.body}, FALSE, ${n.at})`;
  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${n.clientId}, ${n.spaceId}, ${n.dealId}, 'note.created', ${n.authorId}, ${n.at}, 'note', ${id}, ${jsonParam({ noteId: id })})`;
  return id;
}

/** Колокол по сделке: `params` — только id. */
export async function insertDealNotification(tx: Sql, a: { userId: string; kind: string; dealId: string; dedupeKey: string; at: number }): Promise<void> {
  await tx`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, 'deal', ${a.dealId}, ${jsonParam({ dealId: a.dealId })}, ${a.dedupeKey}, ${a.at}, ${a.at})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

// ---------------------------------------------------------------------------
// Требования этапа
// ---------------------------------------------------------------------------

/**
 * Есть ли у сделки «следующий шаг» (D-244): открытая задача со сроком у любого исполнителя или активная будущая
 * запись (`registered`/`confirmed`, начало после `now`).
 */
export async function hasOpenStepTask(tx: Sql, dealId: string, now: number): Promise<boolean> {
  const rows = await tx<{ hit: boolean }>`
    SELECT (EXISTS (SELECT 1 FROM tasks t WHERE t.deal_id = ${dealId} AND t.status = 'open' AND t.due_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = ${dealId} AND b.status IN ('registered','confirmed') AND b.starts_at > ${now}::bigint)) AS hit`;
  return rows[0]?.hit ?? false;
}

/** Есть ли по сделке живая запись (`attended` — явка «Пришёл»). */
export async function dealBookingFacts(tx: Sql, dealId: string): Promise<{ booking: boolean; attended: boolean }> {
  const rows = await tx<{ booking: boolean; attended: boolean }>`
    SELECT EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = ${dealId} AND b.status <> 'cancelled') AS booking,
           EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = ${dealId} AND b.status = 'attended') AS attended`;
  return rows[0] ?? { booking: false, attended: false };
}

/** Ручная задача следующего шага по сделке (как B7): исполнитель — я, `source_key` пуст. */
export async function insertStepTask(
  tx: Sql,
  t: { spaceId: string; clientId: string; dealId: string; kind: 'call' | 'meeting'; dueAt: number; assigneeUserId: string; at: number },
): Promise<string> {
  const id = newId();
  await tx`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
    VALUES (${id}, ${t.spaceId}, ${t.clientId}, ${t.dealId}, ${t.kind}, 'manual', '', ${t.dueAt}, ${t.assigneeUserId}, 'open', NULL, ${t.assigneeUserId}, ${t.at})`;
  return id;
}
