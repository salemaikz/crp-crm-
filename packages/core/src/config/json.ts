// JSON-значения документов настроек: проверка формы, сравнение, канонический вид и хэш ревизии.
// Документ хранится в jsonb: порядок ключей БД не сохраняет, поэтому хэш считается от канонического
// JSON (ключи по алфавиту, без пробелов), а не от того, что вернул драйвер (D-083).

export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

/** Ключи, которые нельзя принимать из файла: присваивание `o['__proto__']` меняет прототип. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(v: unknown): v is JsonObject {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Проверка, что значение — чистый JSON (без undefined, функций, NaN, Infinity, дат, запрещённых ключей). */
export function assertJson(v: unknown, where = '$'): asserts v is Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`${where}: число должно быть конечным`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertJson(x, `${where}[${i}]`));
    return;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) throw new TypeError(`${where}: запрещённый ключ «${k}»`);
      assertJson(v[k], `${where}.${k}`);
    }
    return;
  }
  throw new TypeError(`${where}: значение не JSON`);
}

/** Глубокое сравнение JSON-значений. Порядок ключей объекта не важен, порядок массива важен. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Канонический JSON: ключи по алфавиту (по кодовым единицам), без пробелов. */
export function canonicalJson(v: Json): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('canonicalJson: число должно быть конечным');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] as Json)}`).join(',')}}`;
}

/**
 * sha256 канонического JSON документа, 64 hex-символа (`config_revisions.hash`). WebCrypto, а не
 * `node:crypto`: ядро без зависимостей платформы и работает и в браузере (предпросмотр правок).
 */
export async function configHash(doc: Json): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(doc));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Глубокая копия JSON-значения (документы не мутируются на месте). */
export function cloneJson<T extends Json>(v: T): T {
  return structuredClone(v);
}
