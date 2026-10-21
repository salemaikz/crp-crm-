// Ключи шифрования секретов интеграций из окружения (D-269): CRM_SECRETS_KID — текущий kid,
// CRM_SECRETS_KEY_<kid> — base64, ровно 32 байта (во время ротации ключей несколько).
// Production без текущего ключа — SecretError('no_key') при первом использовании (приложение стартует, экран
// интеграций показывает «нет ключа»). Разработка и тесты без ключей — постоянный тестовый ключ, как hmac.ts.
import { createHash } from 'node:crypto';
import { isProduction, readEnv, type Env } from '../env';
import type { LoadKeyring, SecretErrorCode, SecretKeyring } from './types';

/** Ошибка секретов без подробностей: ни ключа, ни значения, ни имени интеграции в тексте. */
export class SecretError extends Error {
  override name = 'SecretError';
  constructor(readonly code: SecretErrorCode) {
    super(code);
  }
}

export const isSecretError = (e: unknown): e is SecretError => (e as { name?: unknown } | null)?.name === 'SecretError' && typeof (e as { code?: unknown }).code === 'string';

const KEY_PREFIX = 'CRM_SECRETS_KEY_';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** kid тестового ключа: строка, зашифрованная им, на бою не откроется (там такого kid нет). */
export const DEV_KID = 'dev';
const DEV_KEY = createHash('sha256').update('dev-only-integration-secrets-key').digest();

/** base64 → ровно 32 байта, иначе null (неверная длина — как отсутствие ключа: fail closed). */
function decodeKey(raw: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  const buf = Buffer.from(raw, raw.includes('-') || raw.includes('_') ? 'base64url' : 'base64');
  return buf.length === 32 ? new Uint8Array(buf) : null;
}

export const loadKeyring: LoadKeyring = (env: Env = process.env) => {
  const currentKid = readEnv(env, 'CRM_SECRETS_KID');
  const keys = new Map<string, Uint8Array>();
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(KEY_PREFIX) || !value?.trim()) continue;
    const kid = name.slice(KEY_PREFIX.length);
    const key = KID_RE.test(kid) ? decodeKey(value.trim()) : null;
    if (key) keys.set(kid, key);
  }
  if (!currentKid) {
    if (isProduction(env) || keys.size > 0) throw new SecretError('no_key');
    return { currentKid: DEV_KID, keys: new Map([[DEV_KID, new Uint8Array(DEV_KEY)]]) };
  }
  if (!KID_RE.test(currentKid) || !keys.has(currentKid)) throw new SecretError('no_key');
  return { currentKid, keys };
};

/** Есть ли рабочий текущий ключ (для экрана интеграций: «нет ключа шифрования»). Без исключений. */
export function hasSecretsKey(env: Env = process.env): boolean {
  try {
    loadKeyring(env);
    return true;
  } catch {
    return false;
  }
}

export type { SecretKeyring };
