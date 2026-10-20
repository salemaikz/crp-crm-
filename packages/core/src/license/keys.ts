// Открытые ключи лицензий и водяной знак сборки (D-028, D-101, D-211).
// В сборке поставки packages/core/build.mjs подставляет через esbuild `define`:
//   __CRM_LICENSE_KEYS__ — JSON `{ "<kid>": "<base64 32 байта открытого ключа Ed25519>" }` (ключи владельца);
//   __CRM_CUSTOMER_ID__, __CRM_BUILD_ID__ — водяной знак клиента.
// В dev и тестах констант нет: ядро доверяет только тестовому ключу `test-1` ниже. Его закрытая половина
// в репозиторий не попадает (у владельца; тесты подписывают одноразовыми ключами). В сборке клиента
// (водяной знак задан) ключи `test-*` не принимаются никогда — даже если её по ошибке собрали без своих ключей.
import { createPublicKey, type KeyObject } from 'node:crypto';

declare const __CRM_LICENSE_KEYS__: unknown;
declare const __CRM_CUSTOMER_ID__: unknown;
declare const __CRM_BUILD_ID__: unknown;

/** kid → открытый ключ Ed25519 (base64 сырых 32 байт). */
export type TrustedKeys = Readonly<Record<string, string>>;

/** Водяной знак сборки; null — общая сборка (dev, тесты, общий образ без слоя клиента). */
export type Watermark = { customer: string | null; buildId: string | null };

/** Тестовый ключ репозитория. Только для dev, тестов и общей сборки; в сборке клиента не действует. */
export const TEST_KEYS: TrustedKeys = Object.freeze({ 'test-1': 'tW3RIfHgQEA86ddaG5bkfbGdcHTeADZt8khVP8s+5LI=' });

export const isTestKid = (kid: string): boolean => kid.startsWith('test-');

const UNSET = 'unset';

function definedString(read: () => unknown): string | null {
  let v: unknown;
  try {
    v = read();
  } catch {
    return null;
  }
  return typeof v === 'string' && v !== '' && v !== UNSET ? v : null;
}

/** Водяной знак, вшитый при сборке ядра (build.mjs --customer/--build-id). */
export function buildWatermark(): Watermark {
  return {
    customer: definedString(() => (typeof __CRM_CUSTOMER_ID__ !== 'undefined' ? __CRM_CUSTOMER_ID__ : undefined)),
    buildId: definedString(() => (typeof __CRM_BUILD_ID__ !== 'undefined' ? __CRM_BUILD_ID__ : undefined)),
  };
}

const KEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
const KID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Проверить и заморозить набор ключей. Ошибка формата — исключение: сборка с битыми ключами не стартует. */
export function parseTrustedKeys(input: unknown): TrustedKeys {
  const obj = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('license keys: ожидается объект kid → ключ');
  const out: Record<string, string> = {};
  for (const [kid, key] of Object.entries(obj)) {
    if (!KID_RE.test(kid)) throw new Error(`license keys: недопустимый kid ${JSON.stringify(kid)}`);
    if (typeof key !== 'string' || !KEY_B64_RE.test(key) || Buffer.from(key, 'base64').length !== 32) {
      throw new Error(`license keys: ключ ${kid} — не 32 байта base64`);
    }
    out[kid] = key;
  }
  return Object.freeze(out);
}

/** Ключи, вшитые в ядро при сборке; без `define` — тестовый ключ репозитория. */
export function embeddedKeys(): TrustedKeys {
  if (typeof __CRM_LICENSE_KEYS__ === 'undefined') return TEST_KEYS;
  return parseTrustedKeys(__CRM_LICENSE_KEYS__);
}

// Префикс SPKI DER для Ed25519 (RFC 8410): 30 2a 30 05 06 03 2b 65 70 03 21 00 + 32 байта ключа.
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

const keyCache = new Map<string, KeyObject>();

/** KeyObject из base64 сырого ключа (кэш по значению: проверка идёт на каждом обновлении состояния). */
export function publicKeyObject(b64: string): KeyObject {
  let k = keyCache.get(b64);
  if (!k) {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== 32) throw new Error('license keys: ключ не 32 байта');
    k = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    keyCache.set(b64, k);
  }
  return k;
}

/** Сырые 32 байта открытого ключа в base64 (для печати в build define и в тестах). */
export function rawPublicKeyBase64(key: KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(ED25519_SPKI_PREFIX.length)).toString('base64');
}
