// Чтение данных для Viewer: учётка и членства. Единственный SQL слоя доступа вне фрагментов охвата;
// права перечитываются на каждом запросе (ARCHITECTURE §5.2 п. 1), кэша нет.
import type { Sql } from '@/server/platform/db';

export type UserRow = { id: string; isAdmin: boolean; status: 'active' | 'disabled' };
export type MembershipRow = { spaceId: string; roleKey: string; teamId: string | null; isDefault: boolean };

export async function loadUser(sql: Sql, userId: string): Promise<UserRow | null> {
  const rows = await sql<UserRow>`SELECT id, is_admin, status FROM users WHERE id = ${userId}`;
  return rows[0] ?? null;
}

/** Активные членства в включённых пространствах: сначала пространство по умолчанию. */
export async function loadMemberships(sql: Sql, userId: string): Promise<MembershipRow[]> {
  return sql<MembershipRow>`
    SELECT m.space_id, m.role_key, m.team_id, s.is_default
      FROM memberships m JOIN spaces s ON s.id = m.space_id
     WHERE m.user_id = ${userId} AND m.status = 'active' AND s.enabled
     ORDER BY s.is_default DESC, m.created_at, m.space_id`;
}
