// Вход по номеру и паролю, «выйти везде», смена пароля — логика без Next (D-091…D-093).
// Маршруты src/app/api/auth/** только разбирают тело, зовут эти функции и ставят cookie.
import { safeNext } from '../../../shared/safeNext';
import { writeAudit } from '../audit';
import type { Sql } from '../db';
import { rateLimit } from '../ratelimit';
import { hashPassword, needsRehash, passwordProblem, PASSWORD_INPUT_MAX_CHARS, verifyPassword } from './password';
import { createSession, revokeAllSessions } from './session';
import { checkLogin, recordLoginFailure, recordLoginSuccess } from './throttle';
import type { IssuedSession, LoginResult, PasswordProblem, SecurityPolicy } from './types';

/** Номер длиннее — не номер: разбор не запускается. */
const PHONE_INPUT_MAX_CHARS = 32;
const PWCHANGE_LIMIT = 5;
const PWCHANGE_WINDOW_MS = 15 * 60_000;

// В лог процесса — не чаще раза в минуту на причину, без номера и IP (D-093).
const lastThrottleLog = new Map<string, number>();
function logThrottled(reason: string, nowMs: number): void {
  const prev = lastThrottleLog.get(reason);
  if (prev !== undefined && nowMs - prev < 60_000) return;
  lastThrottleLog.set(reason, nowMs);
  console.warn(`[auth] login throttled: ${reason}`);
}


/**
 * Номер для входа → канон `7XXXXXXXXXX`; null — не номер.
 * Правила те же, что у parsePhone ядра (8 или 7 + 10 цифр, 10 цифр → 7 + они); признак «рабочий»
 * не важен: заглушка тоже канон, такой номер просто не найдётся.
 * TODO(K1a): после влития @crm/core/phone заменить на parsePhone(raw, { country: 'KZ', … })?.digits —
 * та же нормализация нужна R2a и `crmctl install` (иначе «8 701…» и «+7 701…» разойдутся).
 */
export function loginPhoneDigits(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > PHONE_INPUT_MAX_CHARS) return null;
  const d = raw.replace(/\D+/g, '');
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) return `7${d.slice(1)}`;
  if (d.length === 10) return `7${d}`;
  return null;
}

/** Маска для экрана приглашения: `+7 701 ••• •• 67`. */
export function maskPhone(phoneDigits: string): string {
  if (/^7\d{10}$/.test(phoneDigits)) return `+7 ${phoneDigits.slice(1, 4)} ••• •• ${phoneDigits.slice(-2)}`;
  return `•••• ${phoneDigits.slice(-2)}`;
}

/**
 * Попытка входа. Порядок: разбор → checkLogin → SELECT по phone_digits → verifyPassword всегда
 * (фиктивный хеш, если строки нет) → неудача: recordLoginFailure, `invalid` с retryAfterMs;
 * успех (status active, пароль совпал): recordLoginSuccess, createSession.
 * `sql` — соединение транзакции вызывающего (createSession пишет несколько строк).
 * `next` — safeNext(input.next) ?? '/'.
 */
export async function attemptLogin(
  sql: Sql,
  input: { phone: string; password: string; next?: string | null; ip: string },
  policy: SecurityPolicy,
  nowMs: number,
): Promise<LoginResult> {
  const { password } = input;
  if (typeof password !== 'string' || !password || [...password].length > PASSWORD_INPUT_MAX_CHARS) {
    return { ok: false, error: 'validation' };
  }
  const phoneDigits = loginPhoneDigits(input.phone);
  if (!phoneDigits) return { ok: false, error: 'validation' };

  const verdict = checkLogin({ phoneDigits, ip: input.ip }, policy.loginAttempts, nowMs);
  if (!verdict.ok) {
    logThrottled(verdict.reason, nowMs);
    return { ok: false, error: 'rate_limited', retryAfterMs: verdict.retryAfterMs };
  }

  const [user] = await sql<{ id: string; passwordHash: string | null; status: string }>`
    SELECT id, password_hash, status FROM users WHERE phone_digits = ${phoneDigits}`;
  // bcrypt считается всегда: время ответа не выдаёт, есть ли номер
  const passwordOk = await verifyPassword(password, user?.passwordHash);
  if (!user || !user.passwordHash || !passwordOk || user.status !== 'active') {
    const delay = recordLoginFailure({ phoneDigits, ip: input.ip }, policy.loginAttempts, nowMs);
    return { ok: false, error: 'invalid', retryAfterMs: delay > 0 ? delay : null };
  }

  recordLoginSuccess(phoneDigits);
  const session = await createSession(sql, { userId: user.id, policy, nowMs });
  if (needsRehash(user.passwordHash)) {
    await sql`UPDATE users SET password_hash = ${await hashPassword(password)} WHERE id = ${user.id}`;
  }
  return { ok: true, userId: user.id, session, next: safeNext(input.next) ?? '/' };
}

/** «Выйти на всех устройствах»: удалить все сессии сотрудника, включая текущую; аудит `session.logout_all`. */
export async function logoutEverywhere(sql: Sql, userId: string, nowMs: number): Promise<{ revoked: number }> {
  const revoked = await revokeAllSessions(sql, userId);
  await writeAudit(sql, {
    actorId: userId,
    action: 'session.logout_all',
    entity: 'session',
    entityId: userId,
    meta: { revoked },
    createdAt: nowMs,
  });
  return { revoked };
}

export type ChangePasswordResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; error: 'wrong_current' | 'same_as_current' | 'rate_limited' | PasswordProblem; retryAfterMs?: number };

/**
 * Смена своего пароля: лимит 5 попыток за 15 мин на сотрудника (`pwchange:<userId>`), сверка
 * текущего, политика нового, новый хеш; в одной транзакции (её открывает вызывающий) — удалить ВСЕ
 * сессии сотрудника и выдать новую этому устройству (ротация, D-092); аудит `user.password_change`.
 */
export async function changeOwnPassword(
  sql: Sql,
  input: { userId: string; current: string; next: string },
  policy: SecurityPolicy,
  nowMs: number,
): Promise<ChangePasswordResult> {
  const limit = rateLimit(`pwchange:${input.userId}`, PWCHANGE_LIMIT, PWCHANGE_WINDOW_MS, nowMs);
  if (!limit.ok) return { ok: false, error: 'rate_limited', retryAfterMs: limit.retryAfterMs };
  if ([...input.current].length > PASSWORD_INPUT_MAX_CHARS || [...input.next].length > PASSWORD_INPUT_MAX_CHARS) {
    return { ok: false, error: 'too_long' };
  }
  const [user] = await sql<{ passwordHash: string | null; phoneDigits: string; status: string }>`
    SELECT password_hash, phone_digits, status FROM users WHERE id = ${input.userId} FOR UPDATE`;
  const currentOk = await verifyPassword(input.current, user?.passwordHash);
  if (!user || user.status !== 'active' || !currentOk) return { ok: false, error: 'wrong_current' };
  if (input.next === input.current) return { ok: false, error: 'same_as_current' };
  const problem = passwordProblem(input.next, user.phoneDigits);
  if (problem) return { ok: false, error: problem };
  const hash = await hashPassword(input.next);
  await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${input.userId}`;
  const revoked = await revokeAllSessions(sql, input.userId);
  const session = await createSession(sql, { userId: input.userId, policy, nowMs });
  await writeAudit(sql, {
    actorId: input.userId,
    action: 'user.password_change',
    entity: 'user',
    entityId: input.userId,
    meta: { revoked },
    createdAt: nowMs,
  });
  return { ok: true, session };
}
