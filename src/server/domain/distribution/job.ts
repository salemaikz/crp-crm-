// Задача воркера «раздача»: `distribute@<пространство>` (docs/distribution-design.md §3.1, docs/worker-design.md).
// Расписание — из настроек: auto_even / top_up → сетка окна раздачи по рабочим дням; manual / off → задачи нет.
import { z } from 'zod';
import type { JobDefinition, JobResult, ScheduleInput, ScheduleSpec } from '@/server/platform/jobs/types';
import { runTick } from './tick';

/** Время на один тик раздачи — 2 минуты (worker-design §3), а не общие 5 минут по умолчанию. */
export const DISTRIBUTE_TIMEOUT_MS = 2 * 60_000;

/** Пропущенный тик не догоняется позже чем через столько минут (D-171). */
export const DISTRIBUTE_GRACE_MIN = 15;

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ScheduleSlice = z
  .object({
    distribution: z
      .object({
        mode: z.enum(['auto_even', 'top_up', 'manual', 'off']),
        schedule: z.object({ from: Hhmm, to: Hhmm, everyMin: z.number().int().min(1), workdaysOnly: z.boolean() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** Расписание задачи по документу пространства; нет документа или режим без автораздачи — null. */
export function distributeSchedule(input: ScheduleInput): ScheduleSpec | null {
  const parsed = ScheduleSlice.safeParse(input.space);
  if (!parsed.success) return null;
  const { mode, schedule } = parsed.data.distribution;
  if (mode === 'manual' || mode === 'off') return null;
  return {
    kind: 'grid',
    from: schedule.from,
    to: schedule.to,
    everyMin: schedule.everyMin,
    days: schedule.workdaysOnly ? 'workdays' : 'all',
    graceMin: DISTRIBUTE_GRACE_MIN,
  };
}

export const distributeJob: JobDefinition = {
  name: 'distribute',
  perSpace: true,
  schedule: distributeSchedule,
  writes: 'business',
  timeoutMs: DISTRIBUTE_TIMEOUT_MS,
  async handler(ctx): Promise<JobResult> {
    if (!ctx.space) throw new Error('distribute: нужен контекст пространства');
    const report = await runTick(ctx.actor, { spaceId: ctx.space.id, runId: ctx.runId, slotAt: ctx.slot.at, now: ctx.now });
    const stats = {
      assigned: report.assigned,
      heldBack: report.heldBack,
      blocked: report.blocked,
      overCap: report.overCap,
      raced: report.raced,
      returned: report.returned,
    };
    ctx.log.info('distribute.tick', { status: report.status, assigned: report.assigned, raced: report.raced });
    if (report.status === 'skipped') return { status: 'skipped', stats, note: report.reason ?? 'skipped' };
    return { status: 'ok', stats };
  },
};
