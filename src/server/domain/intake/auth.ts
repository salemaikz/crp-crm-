// Доступ по ключу приёма (INTEGRATIONS 5.1): ключ → `IngestPrincipal`. Сначала ключ, затем разрешение, затем лимит частоты.
import { getDb } from '@/server/platform/db';
import { rateLimit } from '@/server/platform/ratelimit';
import { bearerOf, parseKey, secretMatches } from './keys';
import * as repo from './repo';
import { INGEST_SCOPES, type IngestPrincipal, type IngestScope } from './types';

/** 60 запросов в минуту на ключ (приём и demand вместе). */
export const KEY_RATE_LIMIT = 60;
export const RATE_WINDOW_MS = 60_000;
/** Неудачные попытки с одного адреса: перебор ключа отсекается раньше, чем он что-то даст. */
export const FAIL_RATE_LIMIT = 30;

export type AuthFailure =
  | { code: 'unauthorized' }
  | { code: 'forbidden_scope' }
  | { code: 'rate_limited'; retryAfterSec: number };

export class IngestAuthError extends Error {
  override name = 'IngestAuthError';
  constructor(readonly failure: AuthFailure) {
    super(failure.code);
  }
}

// Хэш для выравнивания времени ответа, когда ключа с таким prefix нет
const DUMMY_HASH = '0'.repeat(64);

/** Проверить заголовок `Authorization`. `ip` — для счётчика неудачных попыток. Бросает IngestAuthError. */
export async function authenticateKey(authorization: string | null, scope: IngestScope, ip: string, now: number = Date.now()): Promise<IngestPrincipal> {
  const fail = (): never => {
    const r = rateLimit(`ingest:fail:${ip}`, FAIL_RATE_LIMIT, RATE_WINDOW_MS, now);
    if (!r.ok) throw new IngestAuthError({ code: 'rate_limited', retryAfterSec: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) });
    throw new IngestAuthError({ code: 'unauthorized' });
  };

  const parsed = parseKey(bearerOf(authorization) ?? '');
  if (!parsed) return fail();
  const db = await getDb();
  const row = await repo.findKeyByPrefix(db.sql, parsed.prefix);
  const matches = secretMatches(parsed.secret, row?.keyHash ?? DUMMY_HASH);
  if (!row || !matches || row.revokedAt !== null) return fail();

  const scopes = row.scopes.filter((s): s is IngestScope => (INGEST_SCOPES as readonly string[]).includes(s));
  if (!scopes.includes(scope)) throw new IngestAuthError({ code: 'forbidden_scope' });

  const lim = rateLimit(`ingest:key:${row.id}`, KEY_RATE_LIMIT, RATE_WINDOW_MS, now);
  if (!lim.ok) throw new IngestAuthError({ code: 'rate_limited', retryAfterSec: Math.max(1, Math.ceil(lim.retryAfterMs / 1000)) });

  await repo.touchKey(db.sql, row.id, now);
  return Object.freeze({ kind: 'ingest' as const, keyId: row.id, spaceId: row.spaceId, spaceKey: row.spaceKey, sourceKey: row.sourceKey, scopes });
}
