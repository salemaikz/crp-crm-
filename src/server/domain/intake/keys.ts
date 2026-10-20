// Ключи приёма `crm1_<prefix>_<secret>` (INTEGRATIONS 5.1): prefix — 8 символов [a-z0-9], secret — 32 случайных байта
// base64url. В БД лежит только sha256(secret); сравнение — timingSafeEqual. Чистые функции без БД.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const KEY_VERSION = 'crm1';
const PREFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_RE = /^crm1_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedKey {
  /** Показывается один раз, в БД не хранится. */
  key: string;
  prefix: string;
  keyHash: string;
}

export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export function generateKey(): GeneratedKey {
  let prefix = '';
  for (let i = 0; i < 8; i++) prefix += PREFIX_ALPHABET[randomInt(PREFIX_ALPHABET.length)];
  const secret = randomBytes(32).toString('base64url');
  return { key: `${KEY_VERSION}_${prefix}_${secret}`, prefix, keyHash: hashSecret(secret) };
}

/** Разбор ключа. `secret` base64url может содержать «_», поэтому делим по фиксированной длине prefix. */
export function parseKey(raw: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(raw);
  return m ? { prefix: m[1] as string, secret: m[2] as string } : null;
}

/** Ключ из заголовка `Authorization: Bearer …`. */
export function bearerOf(header: string | null | undefined): string | null {
  const m = /^Bearer[ ]+(\S+)$/i.exec((header ?? '').trim());
  return m ? (m[1] as string) : null;
}

/** Сравнение хэша секрета с хранимым за постоянное время. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
