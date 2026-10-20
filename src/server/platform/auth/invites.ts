// Приглашения и сброс пароля по ссылке (D-094). Токен — 32 случайных байта base64url; в
// invites.token_hash — sha256 hex. Ссылка `${APP_ORIGIN}/invite#<токен>`: фрагмент не уходит на
// сервер, в логи nginx и в Referer. Порядок блокировок везде: users → invites (без взаимоблокировок).
import type { Sql } from '../db';
import type {
  InviteAcceptError,
  InviteIssueError,
  InvitePreview,
  IssuedInvite,
  IssuedSession,
  SecurityPolicy,
} from './types';

type Env = Record<string, string | undefined>;

/** Ссылка приглашения: токен только во фрагменте `#`. */
export function inviteLink(token: string, env: Env = process.env): string {
  void token;
  void env;
  throw new Error('inviteLink: P3');
}

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
  void sql;
  void input;
  throw new Error('issueInvite: P3');
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
  void sql;
  void input;
  throw new Error('issuePasswordReset: P3');
}

/** Что показать на /invite: вид, имя и маска номера. null — ссылка неизвестна, использована или истекла. */
export async function inspectInvite(sql: Sql, token: string, nowMs: number): Promise<InvitePreview | null> {
  void sql;
  void token;
  void nowMs;
  throw new Error('inspectInvite: P3');
}

/**
 * Принять ссылку и задать пароль. Хеш пароля считается ДО транзакции. В транзакции: найти ссылку
 * по token_hash (без блокировки) → users по номеру FOR UPDATE (status active) → UPDATE invites
 * SET used_at … WHERE token_hash AND used_at IS NULL AND expires_at > now RETURNING (0 строк —
 * `invalid_token`) → пароль, membership (только kind invite с пространством; ON CONFLICT DO NOTHING)
 * → удалить все сессии сотрудника → createSession. Аудит `user.invite_accept` / `user.password_reset`.
 */
export async function acceptInvite(
  sql: Sql,
  input: { token: string; password: string; policy: SecurityPolicy; nowMs: number },
): Promise<{ ok: true; userId: string; session: IssuedSession } | { ok: false; error: InviteAcceptError }> {
  void sql;
  void input;
  throw new Error('acceptInvite: P3');
}

/**
 * Погасить неиспользованные ссылки номера (отключение сотрудника, D-066). Число погашенных.
 * Зовёт team в транзакции отключения вместе с revokeAllSessions.
 */
export async function revokePendingInvites(sql: Sql, phoneDigits: string, nowMs: number): Promise<number> {
  void sql;
  void phoneDigits;
  void nowMs;
  throw new Error('revokePendingInvites: P3');
}
