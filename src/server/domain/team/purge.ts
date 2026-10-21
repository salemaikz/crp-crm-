// Чистка снимков «до» (часть задачи `purge`, D-062): массовая передача и слияние хранят строки 30 дней для ручного отката.
import type { SystemActor } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { deleteSnapshotsBefore } from './transferRepo';

const BATCH = 5000;

/** Удалить снимки, созданные раньше `before` (epoch-мс), пачками. Возвращает число удалённых строк. */
export async function purgeChangeSnapshots(_actor: SystemActor, before: number): Promise<number> {
  const db = await getDb();
  let total = 0;
  for (;;) {
    const n = await deleteSnapshotsBefore(db.sql, before, BATCH);
    total += n;
    if (n < BATCH) return total;
  }
}
