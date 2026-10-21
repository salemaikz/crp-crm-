// Приглашения и сброс пароля по ссылке (D-094). Токен — 32 случайных байта base64url; в
// invites.token_hash — sha256 hex. Ссылка `${APP_ORIGIN}/invite#<токен>`: фрагмент не уходит на
// сервер, в логи nginx и в Referer. Порядок блокировок везде: users → invites (без взаимоблокировок).
import { createHash, randomBytes } from 'node:crypto';
import { writeAudit } from '../audit';
import { newId, type Sql } from '../db';
import { configuredAppOrigin } from '../stand/origin';
import { maskPhone } from './login';
import { hashPassword, passwordProblem, PASSWORD_INPUT_MAX_CHARS } from './password';
import { createSession, revokeAllSessions, SESSION_TOKEN_RE } from './session';
import type {
  InviteAcceptError,
  InviteIssueError,
  InvitePreview,
  IssuedInvite,
  IssuedSession,
  SecurityPolicy,
} from './types';

type Env = Record<string, string | undefined>;

const HOUR_MS = 3_600_000;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/** Ссылка приглашения: токен только во фрагменте `#`. */
export function inviteLink(token: string, env: Env = process.env): string {
  const raw = configuredAppOrigin(env);
  if (!raw && env.NODE_ENV === 'production') throw new Error('APP_ORIGIN is not set in production (docs/CONFIG.md §7).');
  const origin = raw ? new URL(raw).origin : 'http://localhost:3000';
  return `${origin}/invite#${token}`;
}

/** Погасить неиспользованные ссылки номера; число погашенных. */
async function expirePending(sql: Sql, phoneDigits: string, nowMs: number): Promise<number> {
  const rows = await sql`
    UPDATE invites SET used_at = ${nowMs} WHERE phone_digits = ${phoneDigits} AND used_at IS NULL RETURNING id`;
  return rows.length;
}

async function insertInvite(
  sql: Sql,
  v: {
    kind: 'invite' | 'reset';
    userId: string;
    phoneDigits: string;
    spaceId: string | null;
    roleKey: string;
    teamId: string | null;
    createdBy: string;
    ttlHours: number;
    nowMs: number;
  },
): Promise<IssuedInvite> {
  const token = newToken();
  const inviteId = newId();
  const expiresAt = v.nowMs + v.ttlHours * HOUR_MS;
  await sql`
    INSERT INTO invites (id, token_hash, kind, phone_digits, space_id, role_key, team_id, expires_at, created_by, created_at)
    VALUES (${inviteId}, ${sha256(token)}, ${v.kind}, ${v.phoneDigits}, ${v.spaceId}, ${v.roleKey}, ${v.teamId},
            ${expiresAt}, ${v.createdBy}, ${v.nowMs})`;
  return { inviteId, userId: v.userId, token, link: inviteLink(token), expiresAt };
}

type UserRow = { id: string; passwordHash: string | null; status: string };

/**
 * Приглашение нового сотрудника (R2a, `crmctl install` для первого администратора). В транзакции:
 * users по номеру FOR UPDATE; нет строки — вставить (password_hash NULL, status active, isAdmin);
 * есть с паролем — `exists` (нужен сброс); отключён — `disabled`; роль самому себе — `self_role`
 * (исключение: первый администратор без роли, createdBy = его же id). Прежние неиспользованные
 * ссылки номера гасятся (used_at = now). Аудит `user.invite` (meta: kind, roleKey, spaceId).
 */
export async function issueInvite(
  sql: Sql,
  input: {
    phoneDigits: string;
    name: string;
    /** Пространство и роль задаются вместе или не задаются (CHECK в схеме). */
    spaceId: string | null;
    roleKey: string;
    teamId: string | null;
    /** Только `crmctl install` и администратор установки. */
    isAdmin?: boolean;
    createdBy: string;
    policy: SecurityPolicy;
    nowMs: number;
  },
): Promise<{ ok: true; invite: IssuedInvite } | { ok: false; error: InviteIssueError }> {
  if ((input.spaceId === null) !== (input.roleKey === '')) {
    throw new Error('issueInvite: spaceId и roleKey задаются вместе или не задаются');
  }
  const lock = () => sql<UserRow>`SELECT id, password_hash, status FROM users WHERE phone_digits = ${input.phoneDigits} FOR UPDATE`;
  let [user] = await lock();
  if (!user) {
    const id = newId();
    const inserted = await sql<{ id: string }>`
      INSERT INTO users (id, phone_digits, name, is_admin, created_at)
      VALUES (${id}, ${input.phoneDigits}, ${input.name}, ${input.isAdmin === true}, ${input.nowMs})
      ON CONFLICT (phone_digits) DO NOTHING RETURNING id`;
    if (inserted.length === 0) [user] = await lock(); // параллельная вставка того же номера
    else user = { id, passwordHash: null, status: 'active' };
  }
  if (!user) throw new Error('issueInvite: пользователь не найден после вставки');
  if (user.status === 'disabled') return { ok: false, error: 'disabled' };
  if (user.passwordHash) return { ok: false, error: 'exists' };
  if (input.roleKey !== '' && input.createdBy === user.id) return { ok: false, error: 'self_role' };
  // приглашённый, но не принявший: имя и признак администратора обновляются, строка та же
  await sql`
    UPDATE users SET name = ${input.name}, is_admin = is_admin OR ${input.isAdmin === true} WHERE id = ${user.id}`;
  await expirePending(sql, input.phoneDigits, input.nowMs);
  const invite = await insertInvite(sql, {
    kind: 'invite',
    userId: user.id,
    phoneDigits: input.phoneDigits,
    spaceId: input.spaceId,
    roleKey: input.roleKey,
    teamId: input.teamId,
    createdBy: input.createdBy,
    ttlHours: input.policy.inviteTtlHours,
    nowMs: input.nowMs,
  });
  await writeAudit(sql, {
    actorId: input.createdBy,
    action: 'user.invite',
    entity: 'user',
    entityId: user.id,
    spaceId: input.spaceId,
    meta: { kind: 'invite', roleKey: input.roleKey, spaceId: input.spaceId },
    createdAt: input.nowMs,
  });
  return { ok: true, invite };
}

/**
 * Ссылка сброса пароля, которую администратор передаёт сотруднику сам (D-054 «сброс пароля
 * администратором»). Сессии сотрудника не трогает — их закрывает принятие ссылки.
 * Прежние неиспользованные ссылки гасятся. Аудит `user.password_reset_issue`.
 */
export async function issuePasswordReset(
  sql: Sql,
  input: { userId: string; createdBy: string; policy: SecurityPolicy; nowMs: number },
): Promise<{ ok: true; invite: IssuedInvite } | { ok: false; error: InviteIssueError }> {
  const [user] = await sql<UserRow & { phoneDigits: string }>`
    SELECT id, password_hash, status, phone_digits FROM users WHERE id = ${input.userId} FOR UPDATE`;
  if (!user) return { ok: false, error: 'not_found' };
  if (user.status === 'disabled') return { ok: false, error: 'disabled' };
  await expirePending(sql, user.phoneDigits, input.nowMs);
  const invite = await insertInvite(sql, {
    kind: 'reset',
    userId: user.id,
    phoneDigits: user.phoneDigits,
    spaceId: null,
    roleKey: '',
    teamId: null,
    createdBy: input.createdBy,
    ttlHours: input.policy.inviteTtlHours,
    nowMs: input.nowMs,
  });
  await writeAudit(sql, {
    actorId: input.createdBy,
    action: 'user.password_reset_issue',
    entity: 'user',
    entityId: user.id,
    meta: {},
    createdAt: input.nowMs,
  });
  return { ok: true, invite };
}

type PendingRow = { kind: 'invite' | 'reset'; phoneDigits: string; name: string; passwordHash: string | null };

/** Живая ссылка (не использована, не истекла, сотрудник active) без блокировок. */
async function readPending(sql: Sql, token: string, nowMs: number): Promise<PendingRow | null> {
  if (!SESSION_TOKEN_RE.test(token)) return null; // та же форма: 32 байта base64url
  const [row] = await sql<PendingRow>`
    SELECT i.kind, i.phone_digits, u.name, u.password_hash
    FROM invites i JOIN users u ON u.phone_digits = i.phone_digits
    WHERE i.token_hash = ${sha256(token)} AND i.used_at IS NULL AND i.expires_at > ${nowMs} AND u.status = 'active'`;
  // приглашение для того, у кого пароль уже есть, недействительно (нужен сброс)
  if (!row || (row.kind === 'invite' && row.passwordHash)) return null;
  return row;
}

/** Что показать на /invite: вид, имя и маска номера. null — ссылка неизвестна, использована или истекла. */
export async function inspectInvite(sql: Sql, token: string, nowMs: number): Promise<InvitePreview | null> {
  const row = await readPending(sql, token, nowMs);
  return row ? { kind: row.kind, name: row.name, phoneMasked: maskPhone(row.phoneDigits) } : null;
}

/**
 * Принять ссылку и задать пароль. Хеш пароля считается ДО блокировок. Дальше: найти ссылку по
 * token_hash (без блокировки) → users по номеру FOR UPDATE (status active) → UPDATE invites
 * SET used_at … WHERE token_hash AND used_at IS NULL AND expires_at > now RETURNING (0 строк —
 * `invalid_token`) → пароль, membership (только kind invite с пространством; ON CONFLICT DO NOTHING)
 * → удалить все сессии сотрудника → createSession. Аудит `user.invite_accept` / `user.password_reset`.
 * `sql` — соединение транзакции вызывающего.
 */
export async function acceptInvite(
  sql: Sql,
  input: { token: string; password: string; policy: SecurityPolicy; nowMs: number },
): Promise<{ ok: true; userId: string; session: IssuedSession } | { ok: false; error: InviteAcceptError }> {
  const { token, password, policy, nowMs } = input;
  if (typeof password !== 'string' || [...password].length > PASSWORD_INPUT_MAX_CHARS) return { ok: false, error: 'too_long' };
  const pending = await readPending(sql, token, nowMs);
  if (!pending) return { ok: false, error: 'invalid_token' };
  const problem = passwordProblem(password, pending.phoneDigits);
  if (problem) return { ok: false, error: problem };
  const passwordHash = await hashPassword(password);

  const tokenHash = sha256(token);
  const [user] = await sql<UserRow>`
    SELECT id, password_hash, status FROM users WHERE phone_digits = ${pending.phoneDigits} FOR UPDATE`;
  if (!user || user.status !== 'active') return { ok: false, error: 'invalid_token' };
  const [invite] = await sql<{ kind: 'invite' | 'reset'; spaceId: string | null; roleKey: string; teamId: string | null }>`
    UPDATE invites SET used_at = ${nowMs}
    WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${nowMs}
    RETURNING kind, space_id, role_key, team_id`;
  if (!invite) return { ok: false, error: 'invalid_token' }; // параллельное принятие уже сработало
  if (invite.kind === 'invite' && user.passwordHash) return { ok: false, error: 'invalid_token' };

  await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${user.id}`;
  if (invite.kind === 'invite' && invite.spaceId) {
    // роль, уже изменённая администратором до принятия, важнее ссылки
    await sql`
      INSERT INTO memberships (user_id, space_id, role_key, team_id, created_at, updated_at)
      VALUES (${user.id}, ${invite.spaceId}, ${invite.roleKey}, ${invite.teamId}, ${nowMs}, ${nowMs})
      ON CONFLICT (user_id, space_id) DO NOTHING`;
  }
  await revokeAllSessions(sql, user.id);
  const session = await createSession(sql, { userId: user.id, policy, nowMs });
  await writeAudit(sql, {
    actorId: user.id,
    action: invite.kind === 'invite' ? 'user.invite_accept' : 'user.password_reset',
    entity: 'user',
    entityId: user.id,
    spaceId: invite.kind === 'invite' ? invite.spaceId : null,
    meta: { kind: invite.kind },
    createdAt: nowMs,
  });
  return { ok: true, userId: user.id, session };
}

/**
 * Погасить неиспользованные ссылки номера (отключение сотрудника, D-066). Число погашенных.
 * Зовёт team в транзакции отключения вместе с revokeAllSessions.
 */
export async function revokePendingInvites(sql: Sql, phoneDigits: string, nowMs: number): Promise<number> {
  return expirePending(sql, phoneDigits, nowMs);
}
