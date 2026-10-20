// Чистка платформы (части purge, дизайн worker-design §7): пачки по 5 000 строк до нуля, проверка signal между пачками.
import type { Db } from '../db';
import type { Ms } from './types';

export const PURGE_BATCH = 5000;
const DAY_MS = 86_400_000;

async function loop(signal: AbortSignal | undefined, step: () => Promise<number>): Promise<number> {
  let total = 0;
  while (!signal?.aborted) {
    const n = await step();
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

/** Просроченные сессии. */
export function purgeSessions(db: Db, now: Ms, signal?: AbortSignal): Promise<number> {
  return loop(signal, async () => {
    const r = await db.sql<{ id: string }>`DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ${now} LIMIT ${PURGE_BATCH}) RETURNING id`;
    return r.length;
  });
}

/** Приглашения, просроченные больше 30 дней назад. */
export function purgeInvites(db: Db, now: Ms, signal?: AbortSignal): Promise<number> {
  const before = now - 30 * DAY_MS;
  return loop(signal, async () => {
    const r = await db.sql<{ id: string }>`DELETE FROM invites WHERE id IN (SELECT id FROM invites WHERE expires_at < ${before} LIMIT ${PURGE_BATCH}) RETURNING id`;
    return r.length;
  });
}

/** Закрытые строки push-очереди старше 30 дней. */
export function purgePushOutbox(db: Db, now: Ms, signal?: AbortSignal): Promise<number> {
  const before = now - 30 * DAY_MS;
  return loop(signal, async () => {
    const r = await db.sql<{ id: string }>`
      DELETE FROM push_outbox WHERE id IN (
        SELECT id FROM push_outbox WHERE state IN ('sent','failed','cancelled') AND created_at < ${before} LIMIT ${PURGE_BATCH}) RETURNING id`;
    return r.length;
  });
}
