// SQL входящих передач (B6b): чтение и действия главы отдела. Охват — только через scopeSql(viewer, 'handoff', perm):
// принять и отклонить — `handoff.accept`, назначить — `handoff.assign`, список и карточка — `handoff.read`.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { jsonParam } from '@/server/platform/db/core';
import type { HandoffStatus } from './types';

export interface HandoffRow {
  id: string;
  status: HandoffStatus;
  teamId: string;
  teamKey: string;
  dealId: string;
  clientId: string;
  clientName: string;
  serviceTypeKey: string;
  wonAt: number | null;
  sellerName: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  dueAt: number;
  acceptedAt: number | null;
  createdAt: number;
  declinedReason: string;
  canAccept: boolean;
  canAssign: boolean;
}

/** Строка передачи под блокировкой: достаточно для решения и эффектов. */
export interface LockedHandoff {
  id: string;
  status: HandoffStatus;
  teamId: string;
  spaceIdFrom: string;
  dealId: string;
  clientId: string;
  assigneeUserId: string | null;
  ownerUserId: string | null;
}

/** Список в охвате чтения: ждущие сверху, по сроку. `can` считается теми же охватами действий. */
export async function listHandoffsScoped(viewer: Viewer, sql: Sql, a: { statuses: readonly string[]; limit: number }): Promise<HandoffRow[]> {
  return scoped(sql)<HandoffRow>`
    SELECT h.id, h.status, h.team_id, t.key AS team_key, h.deal_id, h.client_id, cl.name AS client_name,
           d.service_type_key, d.won_at, ou.name AS seller_name, h.assignee_user_id, au.name AS assignee_name,
           h.due_at, h.accepted_at, h.created_at, h.declined_reason,
           (h.status = 'pending' AND ${scopeSql(viewer, 'handoff', 'handoff.accept')}) AS can_accept,
           (h.status IN ('pending', 'accepted') AND ${scopeSql(viewer, 'handoff', 'handoff.assign')}) AS can_assign
      FROM handoffs h JOIN teams t ON t.id = h.team_id JOIN deals d ON d.id = h.deal_id
      JOIN clients cl ON cl.id = h.client_id
      LEFT JOIN users ou ON ou.id = d.owner_user_id LEFT JOIN users au ON au.id = h.assignee_user_id
     WHERE ${scopeSql(viewer, 'handoff', 'handoff.read')} AND h.status = ANY(${[...a.statuses]})
     ORDER BY (h.status = 'pending') DESC, h.due_at, h.id
     LIMIT ${a.limit}`;
}

/**
 * Одна передача. `afterAction` — чтение внутри транзакции уже разрешённого действия: охват чтения не нужен
 * (отклонённая главе отдела больше не видна, а ответ на его же действие вернуть нужно).
 */
export async function findHandoffScoped(viewer: Viewer, sql: Sql, a: { id: string; afterAction?: boolean }): Promise<HandoffRow | null> {
  const bypass = a.afterAction === true;
  const rows = await scoped(sql)<HandoffRow>`
    SELECT h.id, h.status, h.team_id, t.key AS team_key, h.deal_id, h.client_id, cl.name AS client_name,
           d.service_type_key, d.won_at, ou.name AS seller_name, h.assignee_user_id, au.name AS assignee_name,
           h.due_at, h.accepted_at, h.created_at, h.declined_reason,
           (h.status = 'pending' AND ${scopeSql(viewer, 'handoff', 'handoff.accept')}) AS can_accept,
           (h.status IN ('pending', 'accepted') AND ${scopeSql(viewer, 'handoff', 'handoff.assign')}) AS can_assign
      FROM handoffs h JOIN teams t ON t.id = h.team_id JOIN deals d ON d.id = h.deal_id
      JOIN clients cl ON cl.id = h.client_id
      LEFT JOIN users ou ON ou.id = d.owner_user_id LEFT JOIN users au ON au.id = h.assignee_user_id
     WHERE h.id = ${a.id} AND (${scopeSql(viewer, 'handoff', 'handoff.read')} OR ${bypass}::boolean)`;
  return rows[0] ?? null;
}

/** Передача в охвате действия под блокировкой строки; нет — null (чужое и несуществующее неразличимы). */
export async function lockHandoffScoped(viewer: Viewer, tx: Sql, a: { id: string; perm: 'handoff.accept' | 'handoff.assign' }): Promise<LockedHandoff | null> {
  const rows = await scoped(tx)<LockedHandoff>`
    SELECT h.id, h.status, h.team_id, h.space_id_from, h.deal_id, h.client_id, h.assignee_user_id,
           (SELECT d.owner_user_id FROM deals d WHERE d.id = h.deal_id) AS owner_user_id
      FROM handoffs h
     WHERE h.id = ${a.id} AND ${scopeSql(viewer, 'handoff', a.perm)}
       FOR UPDATE OF h`;
  return rows[0] ?? null;
}

/**
 * Повтор действия (D-301): была бы передача в охвате этого действия у зрителя сейчас, если бы её статус был тем,
 * из которого действие выполнялось (`asStatus`). Статус после действия отношение главы отдела может уже не
 * покрывать (отказ), а сменённый глава не покрыт никаким статусом — ему тот же 404, что у чужой.
 * Строка подставляется целиком (`jsonb_populate_record`), меняется только статус: охват считает тот же scopeSql.
 */
export async function inActionScopeAsOf(viewer: Viewer, tx: Sql, a: { id: string; perm: 'handoff.accept' | 'handoff.assign'; asStatus: 'pending' | 'accepted' }): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    SELECT h.id
      FROM handoffs h0
     CROSS JOIN LATERAL jsonb_populate_record(NULL::handoffs, to_jsonb(h0) || jsonb_build_object('status', ${a.asStatus}::text)) h
     WHERE h0.id = ${a.id} AND ${scopeSql(viewer, 'handoff', a.perm)}`;
  return rows.length > 0;
}

export interface ReplayRow {
  kind: string;
  refId: string | null;
  actorId: string | null;
}

export async function findOpEvent(tx: Sql, opId: string): Promise<ReplayRow | null> {
  const rows = await tx<ReplayRow>`SELECT e.kind, e.ref_id, e.actor_id FROM client_events e WHERE e.id = ${opId}`;
  return rows[0] ?? null;
}

/** Принять: только из `pending`, по охвату `handoff.accept`. */
export async function acceptScoped(viewer: Viewer, tx: Sql, a: { id: string; at: number }): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE handoffs h SET status = 'accepted', accepted_at = ${a.at}, accepted_by = ${viewer.userId}
     WHERE h.id = ${a.id} AND h.status = 'pending' AND ${scopeSql(viewer, 'handoff', 'handoff.accept')}
    RETURNING h.id`;
  return rows.length > 0;
}

/** Отклонить: только из `pending`; текст причины — ПДн, только в эту колонку. */
export async function declineScoped(viewer: Viewer, tx: Sql, a: { id: string; reason: string }): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE handoffs h SET status = 'declined', declined_reason = ${a.reason}
     WHERE h.id = ${a.id} AND h.status = 'pending' AND ${scopeSql(viewer, 'handoff', 'handoff.accept')}
    RETURNING h.id`;
  return rows.length > 0;
}

/** Назначить: из `pending` (принимается тем же действием, D-250) и `accepted`. */
export async function assignScoped(viewer: Viewer, tx: Sql, a: { id: string; userId: string; at: number }): Promise<boolean> {
  const rows = await scoped(tx)<{ id: string }>`
    UPDATE handoffs h SET assignee_user_id = ${a.userId}, status = 'accepted',
           accepted_at = COALESCE(h.accepted_at, ${a.at}), accepted_by = COALESCE(h.accepted_by, ${viewer.userId})
     WHERE h.id = ${a.id} AND h.status IN ('pending', 'accepted') AND ${scopeSql(viewer, 'handoff', 'handoff.assign')}
    RETURNING h.id`;
  return rows.length > 0;
}

/** Активный сотрудник отдела передачи (членство в отделе, учётная запись активна). */
export async function isActiveTeamMember(tx: Sql, a: { userId: string; teamId: string }): Promise<boolean> {
  const rows = await tx<{ hit: boolean }>`
    SELECT EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
                    WHERE m.user_id = ${a.userId} AND m.team_id = ${a.teamId} AND m.status = 'active') AS hit`;
  return rows[0]?.hit ?? false;
}

/** Сотрудники отдела передачи, доступной по `handoff.assign`; нет передачи в охвате — null. */
export async function listTeamMembersScoped(viewer: Viewer, sql: Sql, handoffId: string): Promise<{ userId: string; name: string }[] | null> {
  const probe = await scoped(sql)<{ teamId: string }>`
    SELECT h.team_id FROM handoffs h WHERE h.id = ${handoffId} AND h.status IN ('pending', 'accepted') AND ${scopeSql(viewer, 'handoff', 'handoff.assign')}`;
  const team = probe[0]?.teamId;
  if (team === undefined) return null;
  return sql<{ userId: string; name: string }>`
    SELECT u.id AS user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
     WHERE m.team_id = ${team} AND m.status = 'active' ORDER BY u.name, u.id`;
}

/** Событие ленты по передаче с заданным id (ключ повтора). Id занят — false. Без текста причины. */
export async function insertHandoffFeedWithId(
  tx: Sql,
  e: { id: string; clientId: string; spaceId: string; dealId: string; handoffId: string; kind: string; actorId: string; at: number; data: Record<string, string | number | boolean | null> },
): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${e.id}, ${e.clientId}, ${e.spaceId}, ${e.dealId}, ${e.kind}, ${e.actorId}, ${e.at}, 'handoff', ${e.handoffId}, ${jsonParam(e.data)})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Открытая задача исполнителя по ключу переходит к новому исполнителю; была ли такая. */
export async function reassignOpenTask(tx: Sql, a: { sourceKey: string; assigneeUserId: string }): Promise<boolean> {
  const rows = await tx<{ id: string }>`UPDATE tasks SET assignee_user_id = ${a.assigneeUserId} WHERE source_key = ${a.sourceKey} AND status = 'open' RETURNING id`;
  return rows.length > 0;
}
