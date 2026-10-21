// SQL спорных пар (docs/tasks-team-design.md §7.2): список РОП и решение по паре. Стороны пары (карточка, клиент,
// номера) читаются только через scopeSql: сторона, которой зритель не видит, в ответ не попадает.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Permission } from '@/server/access/types';
import type { Sql } from '@/server/platform/db';

export type PairStatus = 'open' | 'merged' | 'distinct' | 'split_allowed';
export type PairReason = 'shared_phone' | 'name_and_head';

export interface PairDbRow {
  id: string;
  aClientId: string;
  bClientId: string;
  reason: PairReason;
  status: PairStatus;
  comment: string;
  createdAt: number;
}

/**
 * Страница пар со статусом по давности (dup_pairs_open_idx для `open`): только пары, у которых хотя бы одна сторона —
 * карточка пространства зрителя, видимая по разрешению. Охват стоит в SQL до LIMIT, поэтому чужие пары не вытесняют свои;
 * курсор — (created_at, id) последней пары.
 */
export async function selectPairsPage(
  sql: Sql,
  viewer: Viewer,
  a: { spaceId: string; status: PairStatus; perm: Permission; after: { createdAt: number; id: string } | null; limit: number },
): Promise<PairDbRow[]> {
  const after = a.after ?? { createdAt: -1, id: '' };
  return scoped(sql)<PairDbRow>`
    SELECT p.id, p.a_client_id, p.b_client_id, p.reason, p.status, p.comment, p.created_at
      FROM dup_pairs p
     WHERE p.status = ${a.status}
       AND (p.created_at, p.id) > (${after.createdAt}::bigint, ${after.id}::text)
       AND EXISTS (SELECT 1 FROM cards c WHERE c.client_id IN (p.a_client_id, p.b_client_id) AND c.space_id = ${a.spaceId}
                     AND ${scopeSql(viewer, 'card', a.perm)})
     ORDER BY p.created_at, p.id LIMIT ${a.limit}`;
}

export interface PairSideRow {
  cardId: string;
  clientId: string;
  name: string;
  orgId: string;
  state: string;
  ownerUserId: string | null;
  ownerName: string | null;
  lastTouchAt: number | null;
  version: number;
}

/** Карточки клиентов в пространстве зрителя, видимые по разрешению: название, БИН, состояние, владелец. */
export async function selectPairSides(sql: Sql, viewer: Viewer, a: { spaceId: string; clientIds: readonly string[]; perm: Permission }): Promise<PairSideRow[]> {
  if (a.clientIds.length === 0) return [];
  return scoped(sql)<PairSideRow>`
    SELECT c.id AS card_id, c.client_id, cl.name, cl.org_id, c.state, c.owner_user_id, u.name AS owner_name, c.last_touch_at, c.version
      FROM cards c JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE c.space_id = ${a.spaceId} AND c.client_id = ANY(${[...a.clientIds]}::text[]) AND ${scopeSql(viewer, 'card', a.perm)}
     ORDER BY c.id`;
}

export interface PairPhoneRow {
  clientId: string;
  digits: string;
  isWorking: boolean;
}

/** Номера клиентов по охвату чтения номеров (тем же разрешением, что и стороны). */
export async function selectPairPhones(sql: Sql, viewer: Viewer, a: { clientIds: readonly string[]; perm: Permission }): Promise<PairPhoneRow[]> {
  if (a.clientIds.length === 0) return [];
  return scoped(sql)<PairPhoneRow>`
    SELECT cp.client_id, cp.digits, cp.is_working FROM client_phones cp
     WHERE cp.client_id = ANY(${[...a.clientIds]}::text[]) AND ${scopeSql(viewer, 'client_phone', a.perm)}
     ORDER BY cp.is_primary DESC, cp.created_at, cp.id`;
}

export async function stopListedHmacs(sql: Sql, hmacs: readonly string[]): Promise<Set<string>> {
  if (hmacs.length === 0) return new Set();
  const rows = await sql<{ phoneHmac: string }>`SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY(${[...hmacs]}::text[])`;
  return new Set(rows.map((r) => r.phoneHmac));
}

/** Пара под блокировкой строки. */
export async function lockPair(tx: Sql, id: string): Promise<PairDbRow | null> {
  const rows = await tx<PairDbRow>`
    SELECT id, a_client_id, b_client_id, reason, status, comment, created_at FROM dup_pairs WHERE id = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Видна ли зрителю хотя бы одна карточка сторон по разрешению. */
export async function pairSideVisible(sql: Sql, viewer: Viewer, a: { clientIds: readonly string[]; perm: Permission }): Promise<boolean> {
  const rows = await scoped(sql)<{ hit: number }>`
    SELECT 1 AS hit FROM cards c WHERE c.client_id = ANY(${[...a.clientIds]}::text[]) AND ${scopeSql(viewer, 'card', a.perm)} LIMIT 1`;
  return rows.length > 0;
}

/** Общий номер рабочий у обеих сторон (PROCESS 7.6: «выдать другому» — только с комментарием). */
export async function sharedWorkingPhone(sql: Sql, a: { aClientId: string; bClientId: string }): Promise<boolean> {
  const rows = await sql<{ hit: number }>`
    SELECT 1 AS hit FROM client_phones p JOIN client_phones q ON q.digits = p.digits
     WHERE p.client_id = ${a.aClientId} AND q.client_id = ${a.bClientId} AND p.is_working AND q.is_working
     LIMIT 1`;
  return rows.length > 0;
}

export async function resolvePairRow(tx: Sql, a: { id: string; status: 'distinct' | 'split_allowed'; comment: string; by: string; now: number }): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    UPDATE dup_pairs SET status = ${a.status}, comment = ${a.comment}, resolved_by = ${a.by}, resolved_at = ${a.now}
     WHERE id = ${a.id} AND status = 'open' RETURNING id`;
  return rows.length === 1;
}
