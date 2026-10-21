// «Сделка залежалась» (B4b, docs/deals-handoffs-design.md §3.5, D-244): число для тревоги РОП.
// Значок «залежалось N дн.» на сделке считает `staleDaysOf` (rules.ts); здесь только агрегат по пространству.
import { getDb } from '@/server/platform/db';
import { countStaleOnStage } from './repo';
import { DAY_MS } from './rules';
import type { CountStaleDeals } from './types';

/** Только число, без id и ПДн. По каждому открытому этапу со `staleDays` — один COUNT по `deals_board_idx`. */
export const countStaleDeals: CountStaleDeals = async ({ spaceId, now, pipelines }) => {
  const db = await getDb();
  let total = 0;
  for (const p of pipelines) {
    for (const s of p.stages) {
      if (s.kind !== 'open' || s.staleDays === null) continue;
      total += await countStaleOnStage(db.sql, { spaceId, pipelineKey: p.key, stageKey: s.key, threshold: now - s.staleDays * DAY_MS });
    }
  }
  return total;
};
