// Вход по номеру и паролю, «выйти везде», смена пароля — логика без Next (D-091…D-093).
// Маршруты src/app/api/auth/** только разбирают тело, зовут эти функции и ставят cookie.
import type { Sql } from '../db';
import type { IssuedSession, LoginResult, PasswordProblem, SecurityPolicy } from './types';

/**
 * Номер для входа → канон `7XXXXXXXXXX` через parsePhone ядра (@crm/core/phone, K1a); null — не номер.
 * Признак «рабочий» не важен: заглушка тоже канон, такой номер просто не найдётся.
 */
export function loginPhoneDigits(raw: string): string | null {
  void raw;
  throw new Error('loginPhoneDigits: P3');
}

/** Маска для экрана приглашения: `+7 701 ••• •• 67`. */
export function maskPhone(phoneDigits: string): string {
  void phoneDigits;
  throw new Error('maskPhone: P3');
}

/**
 * Попытка входа. Порядок: разбор → checkLogin → SELECT по phone_digits → verifyPassword всегда
 * (фиктивный хеш, если строки нет) → неудача: recordLoginFailure, `invalid` с retryAfterMs;
 * успех (status active, пароль совпал): recordLoginSuccess, транзакция createSession.
 * `next` — safeNext(input.next) ?? '/'.
 */
export async function attemptLogin(
  sql: Sql,
  input: { phone: string; password: string; next?: string | null; ip: string },
  policy: SecurityPolicy,
  nowMs: number,
): Promise<LoginResult> {
  void sql;
  void input;
  void policy;
  void nowMs;
  throw new Error('attemptLogin: P3');
}

/** «Выйти на всех устройствах»: удалить все сессии сотрудника, включая текущую; аудит `session.logout_all`. */
export async function logoutEverywhere(sql: Sql, userId: string, nowMs: number): Promise<{ revoked: number }> {
  void sql;
  void userId;
  void nowMs;
  throw new Error('logoutEverywhere: P3');
}

export type ChangePasswordResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; error: 'wrong_current' | 'same_as_current' | 'rate_limited' | PasswordProblem; retryAfterMs?: number };

/**
 * Смена своего пароля: лимит 5 попыток за 15 мин на сотрудника (`pwchange:<userId>`), сверка
 * текущего, политика нового, новый хеш; в одной транзакции — удалить ВСЕ сессии сотрудника и выдать
 * новую этому устройству (ротация, D-092); аудит `user.password_change`.
 */
export async function changeOwnPassword(
  sql: Sql,
  input: { userId: string; current: string; next: string },
  policy: SecurityPolicy,
  nowMs: number,
): Promise<ChangePasswordResult> {
  void sql;
  void input;
  void policy;
  void nowMs;
  throw new Error('changeOwnPassword: P3');
}
