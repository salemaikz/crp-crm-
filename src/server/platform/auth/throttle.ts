// Защита входа от перебора (D-093): по номеру — нарастающая задержка, по IP — блок на окно по
// числу НЕУДАЧ (офис за одним NAT утром не упирается в лимит). Состояние в памяти процесса
// (один процесс, ARCHITECTURE §8.1), своё хранилище в globalThis, ratelimit.ts не меняется.
// Чистые функции от nowMs — тестируются без таймеров. Дизайн: docs/auth-design.md §4.
import type { SecurityPolicy, ThrottleVerdict } from './types';

/** Первая задержка после perPhone неудач и её предел: 1 → 2 → 4 → … → 30 с. */
export const PHONE_DELAY_BASE_MS = 1_000;
export const PHONE_DELAY_MAX_MS = 30_000;
/** Неизвестный IP (UNKNOWN_IP) — общее ведро с пределом perIp × множитель. */
export const UNKNOWN_IP_MULTIPLIER = 5;
/** Предел ключей в памяти; вытеснение — как в ratelimit.ts (истёкшие, затем с меньшим числом неудач). */
export const THROTTLE_MAX_KEYS = 50_000;

/** Задержка после n-й неудачи подряд по номеру (n ≥ perPhone), мс. До perPhone — 0. */
export function phoneDelayMs(failures: number, perPhone: number): number {
  void failures;
  void perPhone;
  throw new Error('phoneDelayMs: P3');
}

/**
 * Можно ли проверять пароль. Не засчитывает попытку. Отказ — без bcrypt и без изменения счётчиков.
 * Порядок: IP (блок до конца окна), затем номер (до nextAt).
 */
export function checkLogin(
  input: { phoneDigits: string; ip: string },
  policy: SecurityPolicy['loginAttempts'],
  nowMs: number,
): ThrottleVerdict {
  void input;
  void policy;
  void nowMs;
  throw new Error('checkLogin: P3');
}

/**
 * Засчитать неудачу (неверный пароль или нет такого номера — одинаково): +1 к IP и к номеру,
 * у номера пересчитать nextAt. Возвращает задержку до следующей попытки по номеру (0 — нет).
 */
export function recordLoginFailure(
  input: { phoneDigits: string; ip: string },
  policy: SecurityPolicy['loginAttempts'],
  nowMs: number,
): number {
  void input;
  void policy;
  void nowMs;
  throw new Error('recordLoginFailure: P3');
}

/** Успешный вход: счётчик номера сбрасывается; неудачи IP остаются (иначе свой аккаунт обнулял бы IP). */
export function recordLoginSuccess(phoneDigits: string): void {
  void phoneDigits;
  throw new Error('recordLoginSuccess: P3');
}

/** Только для тестов: очистить хранилище. */
export function resetLoginThrottle(): void {
  throw new Error('resetLoginThrottle: P3');
}
