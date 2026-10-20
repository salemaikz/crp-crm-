// Тик раздачи пространства (docs/distribution-design.md §3.1): одна транзакция под DISTRIBUTION_LOCK_KEY.
import { distribution as core } from '@crm/core';
import { getDb } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { loadParticipants } from './participants';
import { loadCandidates } from './pool';
import { lockDistribution, runApplied, writeAssignBatch } from './repo';
import type { RunTick, TickReport } from './types';

const EMPTY: Omit<TickReport, 'status'> = { issued: {}, assigned: 0, heldBack: 0, blocked: 0, overCap: 0, raced: 0, returned: 0 };
/** Потолок выборки пула за тик (место у операторов × 2 + запас на двойников и блокировки). */
const MAX_CANDIDATES = 5000;

const skipped = (reason: NonNullable<TickReport['reason']>): TickReport => ({ ...EMPTY, status: 'skipped', reason });

export const runTick: RunTick = async (actor, input, deps = distributionDeps()) => {
  const cfg = await deps.config(input.spaceId, input.now);
  // Окно проверяем по началу слота: тик 18:00, начатый в 18:00:40, не теряется.
  const early = core.planDistribution({ now: input.slotAt, calendar: cfg.calendar, settings: cfg.settings, participants: [], pool: [], mobileFirst: cfg.mobileFirst });
  if (early.status === 'skipped') return skipped(early.reason);
  const day = cfg.calendar.localDay(input.now);

  const db = await getDb();
  return db.tx(async (tx): Promise<TickReport> => {
    await lockDistribution(tx);
    if (await runApplied(tx, { spaceId: input.spaceId, day, runId: input.runId })) return skipped('already_applied');
    // C6c (неделя 2): возвраты «Не интересует» — до пула; здесь returned = 0.
    const participants = await loadParticipants(tx, cfg, input.now, { onlyInDistribution: true });
    const working = participants.filter((p) => p.status === 'working');
    if (working.length === 0) return skipped('no_participants');
    const keep = cfg.settings.mode === 'top_up' ? cfg.settings.topUpKeep : undefined;
    const room = working.reduce((sum, p) => sum + Math.min(p.remaining, keep === undefined ? Infinity : Math.max(0, keep - (p.openNew ?? p.open))), 0);
    if (room <= 0) return skipped('no_room');
    const limit = Math.min(MAX_CANDIDATES, room * 2 + 50);
    const candidates = await loadCandidates(actor, tx, { spaceId: input.spaceId, limit, perm: 'card.assign' });
    if (candidates.length === 0) return skipped('empty_pool');

    const plan = core.planDistribution({
      now: input.slotAt,
      calendar: cfg.calendar,
      settings: cfg.settings,
      participants,
      pool: candidates,
      mobileFirst: cfg.mobileFirst,
    });
    if (plan.status === 'skipped') return skipped(plan.reason);
    const byOperator = Object.fromEntries(Object.entries(plan.byOperator).filter(([, ids]) => ids.length > 0));
    const written = await writeAssignBatch(tx, actor, {
      spaceId: input.spaceId,
      runId: input.runId,
      kind: 'auto',
      byOperator,
      countsToCap: cfg.settings.capIncludes.includes(core.TICK_ISSUE_KIND),
      day,
      actorId: null,
      now: input.now,
    });
    const issued = Object.fromEntries(Object.entries(written.byOperator).map(([u, ids]) => [u, ids.length]));
    return {
      ...EMPTY,
      status: 'done',
      issued,
      assigned: Object.values(issued).reduce((a, n) => a + n, 0),
      heldBack: plan.heldBack.length,
      blocked: plan.blocked.length,
      overCap: plan.overCap.length,
      raced: written.raced.length,
    };
  });
};
