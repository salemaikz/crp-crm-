// Защита входа от перебора (D-093): по номеру — нарастающая задержка, по IP — блок на окно по
// числу НЕУДАЧ (офис за одним NAT утром не упирается в лимит). Состояние в памяти процесса
// (один процесс, ARCHITECTURE §8.1), своё хранилище в globalThis, ratelimit.ts не меняется.
// Чистые функции от nowMs — тестируются без таймеров. Дизайн: docs/auth-design.md §4.
//
// Параллельные попытки (D-151): checkLogin синхронно, до первого await вызывающего, занимает слот
// «идёт проверка» по номеру и по IP. Идущие попытки считаются как будущие неудачи: пачка из 60
// одновременных запросов на один номер даёт не больше perPhone проверок пароля, остальные — отказ.
import { UNKNOWN_IP } from '../http/clientIp';
import type { SecurityPolicy, ThrottleVerdict } from './types';

/** Первая задержка после perPhone неудач и её предел: 1 → 2 → 4 → … → 30 с. */
export const PHONE_DELAY_BASE_MS = 1_000;
export const PHONE_DELAY_MAX_MS = 30_000;
/** Неизвестный IP (UNKNOWN_IP) — общее ведро с пределом perIp × множитель. */
export const UNKNOWN_IP_MULTIPLIER = 5;
/** Предел ключей в памяти; вытеснение — как в ratelimit.ts (истёкшие, затем с меньшим числом неудач). */
export const THROTTLE_MAX_KEYS = 50_000;
/** Отказ из-за идущих попыток: через сколько повторить (проверка пароля занимает доли секунды). */
export const BUSY_RETRY_MS = PHONE_DELAY_BASE_MS;

type Policy = SecurityPolicy['loginAttempts'];
type Entry = { fails: number[]; windowMs: number; nextAt: number };
type Store = {
  phones: Map<string, Entry>;
  ips: Map<string, Entry>;
  /** Идущие сейчас проверки пароля: ключ → число. Размер ограничен числом одновременных запросов. */
  busyPhones: Map<string, number>;
  busyIps: Map<string, number>;
};
const g = globalThis as typeof globalThis & { __crmLoginThrottle?: Partial<Store> };
const raw = (g.__crmLoginThrottle ??= {});
// ??= по полям: хранилище прежней версии модуля (перезагрузка в разработке) дополняется, а не теряется
raw.phones ??= new Map();
raw.ips ??= new Map();
raw.busyPhones ??= new Map();
raw.busyIps ??= new Map();
const store = raw as Store;

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

const busy = (map: Map<string, number>, key: string): number => map.get(key) ?? 0;

function addBusy(map: Map<string, number>, key: string, delta: number): void {
  const n = busy(map, key) + delta;
  if (n > 0) map.set(key, n);
  else map.delete(key);
}

/**
 * Можно ли проверять пароль; если да — попытка СРАЗУ занимает слот по номеру и IP (синхронно, до
 * первого await вызывающего). Вызывающий записывает итог (recordLoginFailure/recordLoginSuccess) и
 * затем вызывает `release()` — в finally. Отказ — без bcrypt и без изменения счётчиков.
 * Порядок: IP (неудачи + идущие против предела), затем номер (nextAt, затем идущие).
 * Номер: пока неудач меньше perPhone, одновременно идут не больше perPhone − неудачи попыток; после —
 * одна (каждая неудача и так продлевает задержку).
 */
export function checkLogin(input: { phoneDigits: string; ip: string }, policy: Policy, nowMs: number): ThrottleVerdict {
  const windowMs = policy.windowMin * 60_000;
  const ipLimit = limitForIp(input.ip, policy);
  const ip = store.ips.get(input.ip);
  const ipFails = ip ? ip.fails.filter((t) => t > nowMs - windowMs) : [];
  if (ipFails.length >= ipLimit) {
    return { ok: false, reason: 'ip_blocked', retryAfterMs: (ipFails[0] as number) + windowMs - nowMs };
  }
  if (ipFails.length + busy(store.busyIps, input.ip) >= ipLimit) {
    return { ok: false, reason: 'ip_blocked', retryAfterMs: BUSY_RETRY_MS };
  }
  const phone = store.phones.get(input.phoneDigits);
  if (phone && nowMs < phone.nextAt) {
    return { ok: false, reason: 'phone_delay', retryAfterMs: phone.nextAt - nowMs };
  }
  const phoneFails = phone ? inWindow(phone, nowMs).length : 0;
  if (busy(store.busyPhones, input.phoneDigits) >= Math.max(1, policy.perPhone - phoneFails)) {
    return { ok: false, reason: 'phone_delay', retryAfterMs: BUSY_RETRY_MS };
  }
  addBusy(store.busyIps, input.ip, 1);
  addBusy(store.busyPhones, input.phoneDigits, 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      addBusy(store.busyIps, input.ip, -1);
      addBusy(store.busyPhones, input.phoneDigits, -1);
    },
  };
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

/** Только для тестов: сколько ключей с идущими попытками (после завершения всех — 0, утечки нет). */
export function inflightSizes(): { phones: number; ips: number } {
  return { phones: store.busyPhones.size, ips: store.busyIps.size };
}

/** Только для тестов: очистить хранилище. */
export function resetLoginThrottle(): void {
  store.phones.clear();
  store.ips.clear();
  store.busyPhones.clear();
  store.busyIps.clear();
}
