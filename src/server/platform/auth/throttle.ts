// Защита входа от перебора (D-093): по номеру — нарастающая задержка, по IP — блок на окно по
// числу НЕУДАЧ (офис за одним NAT утром не упирается в лимит). Состояние в памяти процесса
// (один процесс, ARCHITECTURE §8.1), своё хранилище в globalThis, ratelimit.ts не меняется.
// Чистые функции от nowMs — тестируются без таймеров. Дизайн: docs/auth-design.md §4.
import { UNKNOWN_IP } from '../http/clientIp';
import type { SecurityPolicy, ThrottleVerdict } from './types';

/** Первая задержка после perPhone неудач и её предел: 1 → 2 → 4 → … → 30 с. */
export const PHONE_DELAY_BASE_MS = 1_000;
export const PHONE_DELAY_MAX_MS = 30_000;
/** Неизвестный IP (UNKNOWN_IP) — общее ведро с пределом perIp × множитель. */
export const UNKNOWN_IP_MULTIPLIER = 5;
/** Предел ключей в памяти; вытеснение — как в ratelimit.ts (истёкшие, затем с меньшим числом неудач). */
export const THROTTLE_MAX_KEYS = 50_000;

type Policy = SecurityPolicy['loginAttempts'];
type Entry = { fails: number[]; windowMs: number; nextAt: number };
type Store = { phones: Map<string, Entry>; ips: Map<string, Entry> };
const g = globalThis as typeof globalThis & { __crmLoginThrottle?: Store };
const store: Store = (g.__crmLoginThrottle ??= { phones: new Map(), ips: new Map() });

const inWindow = (e: Entry, nowMs: number): number[] => e.fails.filter((t) => t > nowMs - e.windowMs);

/** Задержка после n-й неудачи подряд по номеру (n ≥ perPhone), мс. До perPhone — 0. */
export function phoneDelayMs(failures: number, perPhone: number): number {
  if (failures < perPhone) return 0;
  const exp = Math.min(failures - perPhone, 20);
  return Math.min(PHONE_DELAY_BASE_MS * 2 ** exp, PHONE_DELAY_MAX_MS);
}

function limitForIp(ip: string, policy: Policy): number {
  return ip === UNKNOWN_IP ? policy.perIp * UNKNOWN_IP_MULTIPLIER : policy.perIp;
}

/**
 * Можно ли проверять пароль. Не засчитывает попытку. Отказ — без bcrypt и без изменения счётчиков.
 * Порядок: IP (блок до конца окна), затем номер (до nextAt).
 */
export function checkLogin(input: { phoneDigits: string; ip: string }, policy: Policy, nowMs: number): ThrottleVerdict {
  const windowMs = policy.windowMin * 60_000;
  const ip = store.ips.get(input.ip);
  if (ip) {
    const fails = ip.fails.filter((t) => t > nowMs - windowMs);
    if (fails.length >= limitForIp(input.ip, policy)) {
      return { ok: false, reason: 'ip_blocked', retryAfterMs: (fails[0] as number) + windowMs - nowMs };
    }
  }
  const phone = store.phones.get(input.phoneDigits);
  if (phone && nowMs < phone.nextAt) {
    return { ok: false, reason: 'phone_delay', retryAfterMs: phone.nextAt - nowMs };
  }
  return { ok: true };
}

function touch(map: Map<string, Entry>, key: string, windowMs: number): Entry {
  const prev = map.get(key);
  const e: Entry = prev ?? { fails: [], windowMs, nextAt: 0 };
  e.windowMs = windowMs;
  // delete + set — ключ уходит в конец порядка обхода (недавно использованный)
  map.delete(key);
  map.set(key, e);
  return e;
}

/**
 * Засчитать неудачу (неверный пароль или нет такого номера — одинаково): +1 к IP и к номеру,
 * у номера пересчитать nextAt. Возвращает задержку до следующей попытки по номеру (0 — нет).
 */
export function recordLoginFailure(input: { phoneDigits: string; ip: string }, policy: Policy, nowMs: number): number {
  const windowMs = policy.windowMin * 60_000;
  const ip = touch(store.ips, input.ip, windowMs);
  ip.fails = inWindow(ip, nowMs);
  ip.fails.push(nowMs);
  const phone = touch(store.phones, input.phoneDigits, windowMs);
  phone.fails = inWindow(phone, nowMs);
  phone.fails.push(nowMs);
  const delay = phoneDelayMs(phone.fails.length, policy.perPhone);
  phone.nextAt = delay > 0 ? nowMs + delay : 0;
  if (store.phones.size > THROTTLE_MAX_KEYS) evict(store.phones, THROTTLE_MAX_KEYS / 2, nowMs);
  if (store.ips.size > THROTTLE_MAX_KEYS) evict(store.ips, THROTTLE_MAX_KEYS / 2, nowMs);
  return delay;
}

/** Успешный вход: счётчик номера сбрасывается; неудачи IP остаются (иначе свой аккаунт обнулял бы IP). */
export function recordLoginSuccess(phoneDigits: string): void {
  store.phones.delete(phoneDigits);
}

/** Ужать карту до target ключей: истёкшие → с меньшим числом неудач → давно не использованные. */
function evict(map: Map<string, Entry>, target: number, nowMs: number): void {
  for (const [k, e] of map) {
    const last = e.fails[e.fails.length - 1];
    if ((last === undefined || last <= nowMs - e.windowMs) && e.nextAt <= nowMs) map.delete(k);
  }
  if (map.size <= target) return;
  let max = 0;
  for (const e of map.values()) max = Math.max(max, e.fails.length);
  for (let threshold = 1; threshold <= max && map.size > target; threshold *= 2) {
    for (const [k, e] of map) {
      if (map.size <= target) return;
      if (e.fails.length <= threshold) map.delete(k);
    }
  }
}

/** Только для тестов: размер хранилищ. */
export function throttleSizes(): { phones: number; ips: number } {
  return { phones: store.phones.size, ips: store.ips.size };
}

/** Только для тестов: очистить хранилище. */
export function resetLoginThrottle(): void {
  store.phones.clear();
  store.ips.clear();
}
