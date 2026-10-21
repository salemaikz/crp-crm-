// SQL передач в отдел (B6: создание при покупке и отмена; B6b добавит входящие). Создание и отмена идут
// внутри транзакции покупки, где карточка и сделка уже заблокированы и проверены по охвату, поэтому строки
// передачи выбираются по `deal_id`, а не через scopeSql (исключение D-302). Чтение входящих (B6b) — только через scopeSql.
import { newId, type Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';

export interface HandoffTeamRow {
  id: string;
  spaceId: string;
  leadUserId: string | null;
  leadActive: boolean;
}

/** Отдел пространства по ключу (не архивный) и активен ли его руководитель. */
export async function findTeamForHandoff(tx: Sql, a: { spaceId: string; teamKey: string }): Promise<HandoffTeamRow | null> {
  const rows = await tx<HandoffTeamRow>`
    SELECT t.id, t.space_id, t.lead_user_id,
           EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
                    WHERE m.user_id = t.lead_user_id AND m.space_id = t.space_id AND m.status = 'active') AS lead_active
      FROM teams t WHERE t.space_id = ${a.spaceId} AND t.key = ${a.teamKey} AND t.archived_at IS NULL`;
  return rows[0] ?? null;
}

/** Новая передача по сделке; уже есть строка этой сделки — null. */
export async function insertHandoff(
  tx: Sql,
  h: { id: string; spaceIdFrom: string; spaceIdTo: string; teamId: string; dealId: string; clientId: string; dueAt: number; at: number },
): Promise<string | null> {
  const rows = await tx<{ id: string }>`
    INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, due_at, created_at)
    VALUES (${h.id}, ${h.spaceIdFrom}, ${h.spaceIdTo}, ${h.teamId}, ${h.dealId}, ${h.clientId}, 'pending', ${h.dueAt}, ${h.at})
    ON CONFLICT (deal_id) DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

/**
 * Отменённая передача сделки снова ждёт (покупку отменили «ошибкой» и зарегистрировали снова, D-250):
 * отдел, исполнитель, принятие, причина отказа и тревога сбрасываются. Не отменённая — null.
 */
export async function reopenCancelledHandoff(tx: Sql, a: { dealId: string; teamId: string; spaceIdTo: string; dueAt: number }): Promise<string | null> {
  const rows = await tx<{ id: string }>`
    UPDATE handoffs SET status = 'pending', team_id = ${a.teamId}, space_id_to = ${a.spaceIdTo}, assignee_user_id = NULL,
                        accepted_at = NULL, accepted_by = NULL, declined_reason = '', due_at = ${a.dueAt}, alarm_sent_at = NULL
     WHERE deal_id = ${a.dealId} AND status = 'cancelled'
    RETURNING id`;
  return rows[0]?.id ?? null;
}

export async function findHandoffIdOfDeal(tx: Sql, dealId: string): Promise<string | null> {
  const rows = await tx<{ id: string }>`SELECT h.id FROM handoffs h WHERE h.deal_id = ${dealId}`;
  return rows[0]?.id ?? null;
}

export interface CancelledHandoffRow {
  id: string;
  /** Статус до отмены: `pending`, `accepted` или `declined`. */
  prevStatus: 'pending' | 'accepted' | 'declined';
  leadUserId: string | null;
  assigneeUserId: string | null;
}

/**
 * Передача сделки, которую ещё ведут или по которой ждёт решения РОП (`pending`, `accepted`, `declined`) →
 * `cancelled` (D-301): иначе отклонённая строка держала бы `ON CONFLICT (deal_id)` и новая покупка не дошла бы
 * до отдела. Вернуть прежний статус, руководителя отдела и исполнителя (для колокола).
 */
export async function cancelOpenHandoff(tx: Sql, dealId: string): Promise<CancelledHandoffRow | null> {
  const rows = await tx<CancelledHandoffRow>`
    WITH prev AS (
      SELECT h0.id, h0.status FROM handoffs h0
       WHERE h0.deal_id = ${dealId} AND h0.status IN ('pending', 'accepted', 'declined')
         FOR UPDATE OF h0
    )
    UPDATE handoffs h SET status = 'cancelled'
      FROM prev, teams t
     WHERE h.id = prev.id AND t.id = h.team_id
    RETURNING h.id, prev.status AS prev_status, t.lead_user_id, h.assignee_user_id`;
  return rows[0] ?? null;
}

/** Задача передачи (`source 'handoff'`) с отделом и сделкой; повтор ключа при открытой задаче — ничего. */
export async function ensureHandoffTask(
  tx: Sql,
  t: { spaceId: string; clientId: string; dealId: string; teamId: string; kind: 'handoff' | 'check'; assigneeUserId: string; dueAt: number; sourceKey: string; createdBy: string | null; at: number },
): Promise<void> {
  await tx`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, team_id, status, source_key, created_by, created_at)
    VALUES (${newId()}, ${t.spaceId}, ${t.clientId}, ${t.dealId}, ${t.kind}, 'handoff', '', ${t.dueAt}, ${t.assigneeUserId}, ${t.teamId}, 'open',
            ${t.sourceKey}, ${t.createdBy}, ${t.at})
    ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND status = 'open' DO NOTHING`;
}

/** Снять открытые задачи передачи по ключам: работа по ней больше не нужна. */
export async function cancelTasksByKeys(tx: Sql, keys: readonly string[], at: number): Promise<number> {
  const rows = await tx<{ id: string }>`
    UPDATE tasks SET status = 'cancelled', done_at = ${at} WHERE source_key = ANY(${[...keys]}) AND status = 'open' RETURNING id`;
  return rows.length;
}

/** Колокол по передаче: `params` — только id. */
export async function insertHandoffNotification(tx: Sql, a: { userId: string; kind: string; handoffId: string; dedupeKey: string; at: number }): Promise<void> {
  await tx`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${a.userId}, ${a.kind}, 'handoff', ${a.handoffId}, ${jsonParam({ handoffId: a.handoffId })}, ${a.dedupeKey}, ${a.at}, ${a.at})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

/** Событие ленты клиента по передаче: коды и id (D-020). */
export async function insertHandoffFeed(
  tx: Sql,
  e: { clientId: string; spaceId: string; dealId: string; handoffId: string; kind: string; actorId: string | null; at: number; data: Record<string, string | number | boolean | null> },
): Promise<void> {
  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'handoff', ${e.handoffId}, ${jsonParam(e.data)})`;
}
