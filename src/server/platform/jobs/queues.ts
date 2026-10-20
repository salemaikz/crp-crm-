// Очереди webhook_inbox и push_outbox (дизайн worker-design §5): аренда FOR UPDATE SKIP LOCKED,
// повторы с растущей паузой, итог по строке. Таблицы выбираются ветвлением, SQL — только шаблоны.
import type { SystemActor } from '@/server/access';
import type { Db } from '../db';
import { errorCode } from './runner';
import type { JobLogger, Ms, QueueItem, QueueName, QueueOutcome, QueueSpec } from './types';

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 3_600_000;

/** Пауза перед повтором: min(30 с · 2^(attempt−1), 1 ч). */
export function queueRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
}

/** Взять пачку под аренду. Одна транзакция: параллельные воркеры не берут одни и те же строки. */
export async function takeBatch(db: Db, name: QueueName, batch: number, leaseMs: number, now: Ms): Promise<QueueItem[]> {
  if (name === 'webhook_inbox') {
    return db.tx(async (sql) => {
      const rows = await sql<{ id: string; kind: string; attempts: number }>`
        UPDATE webhook_inbox SET lease_until = ${now + leaseMs}, attempts = attempts + 1
         WHERE id IN (SELECT id FROM webhook_inbox
                       WHERE state = 'pending' AND next_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
                       ORDER BY next_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, attempts`;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const plugins = await sql<{ id: string; pluginId: string }>`
        SELECT w.id, i.plugin_id FROM webhook_inbox w JOIN integrations i ON i.id = w.integration_id WHERE w.id = ANY(${ids})`;
      const byId = new Map(plugins.map((p) => [p.id, p.pluginId]));
      return rows
        .map((r) => ({ id: r.id, handlerKey: byId.get(r.id) ?? '', kind: r.kind, attempt: r.attempts }))
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    });
  }
  const rows = await db.sql<{ id: string; attempts: number }>`
    UPDATE push_outbox SET lease_until = ${now + leaseMs}, attempts = attempts + 1
     WHERE id IN (SELECT id FROM push_outbox
                   WHERE state = 'pending' AND next_at <= ${now} AND (lease_until IS NULL OR lease_until < ${now})
                   ORDER BY next_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED)
    RETURNING id, attempts`;
  return rows.map((r) => ({ id: r.id, handlerKey: 'push', kind: '', attempt: r.attempts }));
}

/** Итог по строке: done / повтор с паузой / failed. Возвращает итоговое состояние строки. */
export async function settle(
  db: Db,
  name: QueueName,
  item: QueueItem,
  outcome: QueueOutcome,
  maxAttempts: number,
  now: Ms,
): Promise<'done' | 'retry' | 'failed'> {
  const final: 'done' | 'retry' | 'failed' =
    outcome.status === 'done' ? 'done' : outcome.status === 'failed' || item.attempt >= maxAttempts ? 'failed' : 'retry';
  const error = outcome.status === 'done' ? '' : outcome.error.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  const nextAt = now + queueRetryDelayMs(item.attempt);
  if (name === 'webhook_inbox') {
    if (final === 'done') await db.sql`UPDATE webhook_inbox SET state = 'done', processed_at = ${now}, lease_until = NULL, error = '' WHERE id = ${item.id}`;
    else if (final === 'failed') await db.sql`UPDATE webhook_inbox SET state = 'failed', lease_until = NULL, error = ${error} WHERE id = ${item.id}`;
    else await db.sql`UPDATE webhook_inbox SET next_at = ${nextAt}, lease_until = NULL, error = ${error} WHERE id = ${item.id}`;
  } else if (final === 'done') {
    await db.sql`UPDATE push_outbox SET state = 'sent', sent_at = ${now}, lease_until = NULL, error = '' WHERE id = ${item.id}`;
  } else if (final === 'failed') {
    await db.sql`UPDATE push_outbox SET state = 'failed', lease_until = NULL, error = ${error} WHERE id = ${item.id}`;
  } else {
    await db.sql`UPDATE push_outbox SET next_at = ${nextAt}, lease_until = NULL, error = ${error} WHERE id = ${item.id}`;
  }
  return final;
}

export interface QueuePassStats {
  taken: number;
  done: number;
  retried: number;
  failed: number;
}

/** Один проход очереди: взять пачку, обработать по одной строке, записать итоги. */
export async function runQueuePass(
  db: Db,
  spec: QueueSpec,
  ctx: { actor: SystemActor; now: () => Ms; signal: AbortSignal; log: JobLogger },
): Promise<QueuePassStats> {
  const stats: QueuePassStats = { taken: 0, done: 0, retried: 0, failed: 0 };
  const items = await takeBatch(db, spec.name, spec.batch, spec.leaseMs, ctx.now());
  stats.taken = items.length;
  for (const item of items) {
    // Остановка воркера: недообработанная строка вернётся по истечении аренды
    if (ctx.signal.aborted) break;
    const handler = spec.handlers.get(item.handlerKey);
    let outcome: QueueOutcome;
    if (!handler) outcome = { status: 'retry', error: 'no_handler' };
    else {
      try {
        outcome = await handler(ctx.actor, item, ctx.signal);
      } catch (e) {
        ctx.log.warn('queue_handler_failed', { queue: spec.name, code: errorCode(e) });
        outcome = { status: 'retry', error: errorCode(e) };
      }
    }
    const res = await settle(db, spec.name, item, outcome, spec.maxAttempts, ctx.now());
    if (res === 'done') stats.done++;
    else if (res === 'retry') stats.retried++;
    else stats.failed++;
  }
  return stats;
}
