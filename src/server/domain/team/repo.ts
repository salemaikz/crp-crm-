// SQL модуля «Сотрудники». Единственное место, где модуль ходит в БД; интерфейсу репозиторий недоступен.
import type { Sql } from '@/server/platform/db';

export type StaffRecord = {
  id: string;
  name: string;
  phoneDigits: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  hasPassword: boolean;
  lastLoginAt: number | null;
  /** Роль активного или отключённого членства в пространстве. */
  memberRole: string | null;
  /** Последнее приглашение (любое по состоянию): роль и признак «жива». */
  inviteRole: string | null;
  inviteLive: boolean | null;
};

/** Пространство по умолчанию: куда попадают приглашённые, когда у администратора нет своего. */
export async function defaultSpaceId(sql: Sql): Promise<string | null> {
  const [row] = await sql<{ id: string }>`SELECT id FROM spaces WHERE is_default AND enabled LIMIT 1`;
  return row?.id ?? null;
}

/** Все сотрудники установки. Членство берётся в пространстве запроса; приглашение — последнее по номеру. */
export async function listStaff(sql: Sql, spaceId: string | null, nowMs: number): Promise<StaffRecord[]> {
  return sql<StaffRecord>`
    SELECT u.id, u.name, u.phone_digits, u.is_admin, u.status, u.last_login_at,
           (u.password_hash IS NOT NULL) AS has_password,
           m.role_key AS member_role,
           i.role_key AS invite_role,
           (i.used_at IS NULL AND i.expires_at > ${nowMs}) AS invite_live
    FROM users u
    LEFT JOIN memberships m ON m.user_id = u.id AND m.space_id = ${spaceId}
    LEFT JOIN LATERAL (
      SELECT role_key, used_at, expires_at FROM invites
      WHERE phone_digits = u.phone_digits AND kind = 'invite'
      ORDER BY created_at DESC LIMIT 1
    ) i ON TRUE
    ORDER BY (u.status = 'disabled'), lower(u.name), u.id`;
}

export type LockedUser = {
  id: string;
  name: string;
  phoneDigits: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
  hasPassword: boolean;
};

/** Сотрудник под блокировкой строки (порядок блокировок как в auth: users первым). */
export async function lockUser(sql: Sql, id: string): Promise<LockedUser | null> {
  const [row] = await sql<LockedUser>`
    SELECT id, name, phone_digits, is_admin, status, (password_hash IS NOT NULL) AS has_password
    FROM users WHERE id = ${id} FOR UPDATE`;
  return row ?? null;
}

/** Роль и пространство последнего приглашения сотрудника (для повторной отправки). */
export async function lastInvite(sql: Sql, phoneDigits: string): Promise<{ spaceId: string | null; roleKey: string; teamId: string | null } | null> {
  const [row] = await sql<{ spaceId: string | null; roleKey: string; teamId: string | null }>`
    SELECT space_id, role_key, team_id FROM invites
    WHERE phone_digits = ${phoneDigits} AND kind = 'invite'
    ORDER BY created_at DESC LIMIT 1`;
  return row ?? null;
}

/** Роль сотрудника в пространстве (любой статус членства). */
export async function memberRole(sql: Sql, userId: string, spaceId: string): Promise<{ roleKey: string } | null> {
  const [row] = await sql<{ roleKey: string }>`
    SELECT role_key FROM memberships WHERE user_id = ${userId} AND space_id = ${spaceId}`;
  return row ?? null;
}

/** Назначить роль: создаёт членство или меняет роль существующего. Отключённое членство не оживляет. */
export async function upsertRole(sql: Sql, userId: string, spaceId: string, roleKey: string, nowMs: number): Promise<void> {
  await sql`
    INSERT INTO memberships (user_id, space_id, role_key, created_at, updated_at)
    VALUES (${userId}, ${spaceId}, ${roleKey}, ${nowMs}, ${nowMs})
    ON CONFLICT (user_id, space_id) DO UPDATE SET role_key = EXCLUDED.role_key, updated_at = EXCLUDED.updated_at`;
}

export async function setAdmin(sql: Sql, userId: string, isAdmin: boolean): Promise<void> {
  await sql`UPDATE users SET is_admin = ${isAdmin} WHERE id = ${userId}`;
}

/** Закрыть вход: учётка и все членства отключаются, вне раздач. */
export async function disableUser(sql: Sql, userId: string, nowMs: number): Promise<void> {
  await sql`UPDATE users SET status = 'disabled', disabled_at = ${nowMs} WHERE id = ${userId}`;
  await sql`
    UPDATE memberships SET status = 'disabled', in_distribution = FALSE, updated_at = ${nowMs}
    WHERE user_id = ${userId} AND status <> 'disabled'`;
}
