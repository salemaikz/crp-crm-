// Задачи воркера домена записи. `grey-assign@<пространство>` — автоназначение «серых» консультаций (D-247).
// Расписание — из настроек: сетка `booking.grey.schedule` по рабочим дням; пропущенный шаг не догоняем (D-171).
// Флаг BK_WIZARD выключен — прогон пропускается с пометкой `flag_off`.
import { z } from 'zod';
import { isFeatureEnabled } from '@/server/platform/flags';
import type { JobDefinition, JobResult, ScheduleInput, ScheduleSpec } from '@/server/platform/jobs/types';
import { bookingDeps } from './deps';
import { runGreyAssign } from './greyJob';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const ScheduleSlice = z
  .object({
    booking: z.object({ grey: z.object({ schedule: z.object({ first: Hhmm, last: Hhmm, stepMin: z.number().int().min(1) }).passthrough() }).passthrough() }).passthrough(),
  })
  .passthrough();

/** Расписание по документу пространства; нет документа — задачи нет. */
export function greyAssignSchedule(input: ScheduleInput): ScheduleSpec | null {
  const parsed = ScheduleSlice.safeParse(input.space);
  if (!parsed.success) return null;
  const { first, last, stepMin } = parsed.data.booking.grey.schedule;
  return { kind: 'grid', from: first, to: last, everyMin: stepMin, days: 'workdays', graceMin: stepMin };
}

export const greyAssignJob: JobDefinition = {
  name: 'grey-assign',
  perSpace: true,
  schedule: greyAssignSchedule,
  writes: 'business',
  async handler(ctx): Promise<JobResult> {
    if (!ctx.space) throw new Error('grey-assign: нужен контекст пространства');
    if (!isFeatureEnabled('BK_WIZARD')) return { status: 'skipped', stats: {}, note: 'flag_off' };
    const report = await runGreyAssign(bookingDeps(), ctx.actor, { spaceId: ctx.space.id, now: ctx.now });
    ctx.log.info('grey-assign.run', { mode: report.mode, assigned: report.assigned, suggested: report.suggested, unassignable: report.unassignable });
    return { status: 'ok', stats: { assigned: report.assigned, suggested: report.suggested, unassignable: report.unassignable } };
  },
};
