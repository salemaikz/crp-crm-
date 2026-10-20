// Транзакция итога и пропуска: повтор при взаимной блокировке (40P01), сбое сериализации (40001) и гонке
// одного opId (`duplicate_race`) — повтор ответит `duplicate` (docs/calls-design.md §4.2, §4.4).
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { getDb, type Sql } from '@/server/platform/db';

export const lockTimeoutSql = async (tx: Sql): Promise<void> => {
  await tx`SET LOCAL lock_timeout = '5s'`;
};

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRace = (e: unknown): boolean => e instanceof Error && e.message === 'duplicate_race';

export async function inCallsTx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(async (tx) => {
        await lockTimeoutSql(tx);
        return fn(tx);
      });
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !(isRetryableTxError(e) || isRace(e))) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}
