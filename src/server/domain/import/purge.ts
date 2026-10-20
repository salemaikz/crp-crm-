// Чистка строк импорта по сроку (дизайн C4d §11): задача purge воркера (P7) вызывает её в 03:30.
// imports остаётся (счётчики); apply/rows после чистки → 410 rows_expired.
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import * as repo from './repo';
import type { PurgeImportRows } from './types';

const DAY_MS = 86_400_000;
const PACK = 5000;

export const purgeExpiredImportRows: PurgeImportRows = async (_system, now) => {
  const cfg = await getActiveConfig({ now });
  const db = await getDb();
  let deleted = 0;
  for (const s of Object.values(cfg.spaces)) {
    const cutoff = now - s.doc.import.rowsRetentionDays * DAY_MS;
    for (;;) {
      const n = await repo.purgeRowsBefore(db.sql, s.spaceId, cutoff, PACK);
      deleted += n;
      if (n < PACK) break;
    }
  }
  return { deleted };
};
