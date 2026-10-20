// Ограничение частоты: скользящее окно в памяти процесса (вход, приём лидов, приглашения).
// Источник: платформа LMS 2cd8a2b src/lib/auth/rateLimit.ts (без лимитов авторизации — они приедут с P3).
// Приложение работает одним процессом (ARCHITECTURE §8.1), поэтому лимит в памяти достаточен.
//
// Размер хранилища ограничен (RATE_LIMIT_MAX_KEYS). При переполнении сначала удаляются ключи с
// истёкшим окном, затем — с наименьшим числом попыток (среди равных — давно не использованные).
// Ключ, по которому идёт перебор, вытесняется последним.

type Entry = { hits: number[]; windowMs: number };
type Store = Map<string, Entry>;
const g = globalThis as typeof globalThis & { __crmRateLimit?: Store };
const store: Store = (g.__crmRateLimit ??= new Map());

/** Предел числа ключей в памяти; при превышении хранилище ужимается до половины. */
export const RATE_LIMIT_MAX_KEYS = 50_000;

export type RateLimitResult = { ok: boolean; retryAfterMs: number };

/** Засчитывает попытку по ключу. ok=false — лимит исчерпан (попытка не засчитывается). */
export function rateLimit(key: string, limit: number, windowMs: number, nowMs = Date.now()): RateLimitResult {
  const from = nowMs - windowMs;
  const prev = store.get(key);
  const hits = (prev?.hits ?? []).filter((t) => t > from);
  // delete + set — ключ переезжает в конец порядка обхода Map (недавно использованный)
  store.delete(key);
  store.set(key, { hits, windowMs: Math.max(windowMs, prev?.windowMs ?? 0) });
  if (hits.length >= limit) {
    return { ok: false, retryAfterMs: (hits[0] as number) + windowMs - nowMs };
  }
  hits.push(nowMs);
  if (store.size > RATE_LIMIT_MAX_KEYS) evictRateLimitKeys(RATE_LIMIT_MAX_KEYS / 2, nowMs);
  return { ok: true, retryAfterMs: 0 };
}

/** Сбросить счётчик ключа (например, после успешного входа). */
export function resetRateLimit(key: string): void {
  store.delete(key);
}

/** Текущее число ключей (для тестов и диагностики). */
export function rateLimitSize(): number {
  return store.size;
}

/**
 * Ужать хранилище до target ключей: истёкшие → с наименьшим числом попыток → давно не
 * использованные. Ключи с большим числом попыток (идёт перебор) удаляются последними.
 */
export function evictRateLimitKeys(target: number, nowMs = Date.now()): void {
  for (const [k, e] of store) {
    const last = e.hits[e.hits.length - 1];
    if (last === undefined || last <= nowMs - e.windowMs) store.delete(k);
  }
  if (store.size <= target) return;
  let maxHits = 0;
  for (const e of store.values()) maxHits = Math.max(maxHits, e.hits.length);
  for (let threshold = 1; threshold <= maxHits && store.size > target; threshold *= 2) {
    for (const [k, e] of store) {
      if (store.size <= target) return;
      if (e.hits.length <= threshold) store.delete(k);
    }
  }
}
