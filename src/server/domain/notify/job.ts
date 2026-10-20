// Задачи воркера: `digest@<пространство>` (утренняя сводка) и `alarms@<пространство>` (тревоги РОП).
// Реестр — worker-design §6: digest — `daily notifications.morningDigestAt workdays`, null → выкл;
// alarms — `grid 09:00–18:00 / 60 workdays`, grace 15. Подключение — по строке в src/server/jobs/registry.ts.
import type { JobDefinition, JobResult, ScheduleInput, ScheduleSpec } from '@/server/platform/jobs/types';
import { runAlarms } from './alarms';
import { runDigest } from './digest';
import { morningDigestAt } from './settings';

/** Пропущенный тик тревог не догоняется позже чем через столько минут (D-171). */
export const ALARMS_GRACE_MIN = 15;

export function digestSchedule(input: ScheduleInput): ScheduleSpec | null {
  const at = morningDigestAt(input.space);
  return at === null ? null : { kind: 'daily', at, days: 'workdays' };
}

export function alarmsSchedule(): ScheduleSpec {
  return { kind: 'grid', from: '09:00', to: '18:00', everyMin: 60, days: 'workdays', graceMin: ALARMS_GRACE_MIN };
}

export const digestJob: JobDefinition = {
  name: 'digest',
  perSpace: true,
  schedule: digestSchedule,
  writes: 'business',
  async handler(ctx): Promise<JobResult> {
    if (!ctx.space) throw new Error('digest: нужен контекст пространства');
    const r = await runDigest(ctx.actor, { spaceId: ctx.space.id, now: ctx.now, calendar: ctx.calendar });
    ctx.log.info('digest.done', { created: r.created });
    return { status: 'ok', stats: { operators: r.operators, managers: r.managers, created: r.created } };
  },
};

export const alarmsJob: JobDefinition = {
  name: 'alarms',
  perSpace: true,
  schedule: alarmsSchedule,
  writes: 'business',
  async handler(ctx): Promise<JobResult> {
    if (!ctx.space) throw new Error('alarms: нужен контекст пространства');
    const r = await runAlarms(ctx.actor, { spaceId: ctx.space.id, now: ctx.now, calendar: ctx.calendar });
    ctx.log.info('alarms.done', { written: r.written });
    return { status: 'ok', stats: { overdueCallbacks: r.overdueCallbacks, handoffs: r.handoffs, grey: r.grey, written: r.written } };
  },
};
