// Транзакция действия со сделкой: своя, с повтором при взаимной блокировке или сбое сериализации (как booking/tx.ts).
// Повтор безопасен: идемпотентность — `client_events.id = opId` (D-248), повтор видит записанное и отвечает тем же.
import { getDb, type Sql } from '@/server/platform/db';
import { MAX_TX_ATTEMPTS, isRetryableTxError } from '@/server/domain/booking/tx';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function inDealsTx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const db = await getDb();
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(fn);
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}
