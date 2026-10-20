// Транзакция записи: своя с повтором при взаимной блокировке или сбое сериализации (D-131) либо чужая
// (итог «Договорились» в C5) — без повтора, потому что откатывать и повторять нужно всю внешнюю транзакцию.
import { getDb, type Sql } from '@/server/platform/db';
import type { TxOptions } from './types';

/** Сколько раз выполняем транзакцию при 40P01/40001. */
export const MAX_TX_ATTEMPTS = 3;

export function isRetryableTxError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === '40P01' || code === '40001';
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function inBookingTx<T>(opts: TxOptions, fn: (sql: Sql) => Promise<T>): Promise<T> {
  if (opts.tx) return fn(opts.tx);
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(fn);
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      // Небольшая случайная пауза разводит конкурентов, которые только что взяли друг друга в клинч.
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}
