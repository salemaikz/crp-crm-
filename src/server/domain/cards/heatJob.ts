// Пересчёт кэша признаков и горячести пачками (docs/pipeline-v2-design.md §5.1, §6.4). Нужен в двух случаях:
// 1) после смены ревизии настроек с другими весами и после установки версии с другой формулой — задача
//    `calling-heat-recompute` сравнивает отпечаток с прошлым полным прогоном и пересчитывает пространство;
// 2) для существующих строк после миграции — `crmctl` (scripts/crmctl/calling-derived-backfill.ts).
// Пересчёт идемпотентен и не меняет `version`: повтор и параллельная ручная запись ничего не портят.
import type { SystemActor } from '@/server/access';
import { getDb } from '@/server/platform/db';
import type { JobDefinition, JobResult } from '@/server/platform/jobs';
import { loadBoardSettings, heatFingerprint } from './boardSettings';
import { refreshCardDerived } from './derived';
import { selectCardIdsPage, selectLastFullPass } from './derivedRepo';

/** Размер пачки (§5.1). */
export const HEAT_BATCH = 1000;
/** Версия формулы горячести и набора признаков: растёт, когда меняется код расчёта (пересчёт после установки версии). */
export const HEAT_RULES_VERSION = 1;
/** Даже без смены весов кэш сверяется раз в сутки: явка и покупка до B1 обновляют его только при записи карточки. */
const FULL_PASS_MAX_AGE_MS = 24 * 3_600_000;

export interface HeatRecomputeResult {
  cards: number;
  changed: number;
}

/** Пересчитать все карточки пространства пачками по `HEAT_BATCH`; между пачками проверяется `signal`. */
export async function recomputeSpaceHeat(actor: SystemActor, a: { spaceId: string; signal?: AbortSignal; batch?: number }): Promise<HeatRecomputeResult> {
  const db = await getDb();
  const batch = a.batch ?? HEAT_BATCH;
  let afterId = '';
  const out: HeatRecomputeResult = { cards: 0, changed: 0 };
  for (;;) {
    if (a.signal?.aborted) throw new Error('aborted');
    const done = await db.tx(async (tx) => {
      const ids = await selectCardIdsPage(actor, tx, { spaceId: a.spaceId, afterId, limit: batch });
      if (ids.length === 0) return true;
      // Карточку, которую в эту минуту пишет другая транзакция, пропускаем: её запись сама пересчитает кэш
      out.changed += await refreshCardDerived(actor, tx, ids, { skipLocked: true });
      out.cards += ids.length;
      afterId = ids[ids.length - 1]!;
      return ids.length < batch;
    });
    if (done) return out;
  }
}

/** Отпечаток весов и версии формулы: целое, влезает в stats. */
export async function heatStateFingerprint(spaceId: string): Promise<number> {
  return (heatFingerprint(await loadBoardSettings(spaceId)) + Math.imul(HEAT_RULES_VERSION, 7919)) >>> 0;
}

export const heatRecomputeJob: JobDefinition = {
  name: 'calling-heat-recompute',
  perSpace: true,
  // Проверка отпечатка дешёвая; полный пересчёт — только при смене весов или раз в сутки
  schedule: () => ({ kind: 'interval', everyMin: 60 }),
  writes: 'housekeeping',
  timeoutMs: 30 * 60_000,
  handler: async (ctx): Promise<JobResult> => {
    if (!ctx.space) return { status: 'skipped', stats: {}, note: 'no_space' };
    const fp = await heatStateFingerprint(ctx.space.id);
    const db = await getDb();
    const last = await selectLastFullPass(db.sql, ctx.actor.job);
    if (last && last.fp === fp && ctx.now - last.finishedAt < FULL_PASS_MAX_AGE_MS) return { status: 'skipped', stats: { fp }, note: 'unchanged' };
    const r = await recomputeSpaceHeat(ctx.actor, { spaceId: ctx.space.id, signal: ctx.signal });
    ctx.log.info('heat_recomputed', { cards: r.cards, changed: r.changed });
    return { status: 'ok', stats: { fp, full: 1, cards: r.cards, changed: r.changed } };
  },
};
