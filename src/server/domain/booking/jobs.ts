// Задачи воркера домена записи. `grey-assign@<пространство>` — автоназначение «серых» консультаций (D-247).
// Расписание — из настроек: сетка `booking.grey.schedule` по рабочим дням; пропущенный шаг не догоняем (D-171).
// Флаг BK_WIZARD выключен — прогон пропускается с пометкой `flag_off`.
import { z } from 'zod';
import { isFeatureEnabled } from '@/server/platform/flags';
import type { JobDefinition, JobResult, ScheduleInput, ScheduleSpec } from '@/server/platform/jobs/types';
import { bookingDeps } from './deps';
import { runGreyAssign } from './greyJob';
import { runAttendanceSweep } from './sweep';

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

/**
 * `attendance-sweep@<пространство>`: рабочие дни в час `booking.attendance.sweepAt` (умолчание 10:00) — неотмеченная явка (D-243) и «Договорились» без шага (D-244).
 * Выключатель автонеявки — `booking.attendance.autoNoShowWorkdays: null` (остаются только напоминания).
 */
/** Час прогона по умолчанию, если `booking.attendance.sweepAt` не задан (D-243). */
export const DEFAULT_ATTENDANCE_SWEEP_AT = '10:00';

const SweepSlice = z
  .object({ booking: z.object({ attendance: z.object({ sweepAt: Hhmm.optional() }).passthrough() }).passthrough() })
  .passthrough();

/** Расписание `attendance-sweep`: рабочие дни, час из настроек пространства (умолчание 10:00). */
export function attendanceSweepSchedule(input: ScheduleInput): ScheduleSpec | null {
  const parsed = SweepSlice.safeParse(input.space);
  const at = parsed.success ? (parsed.data.booking.attendance.sweepAt ?? DEFAULT_ATTENDANCE_SWEEP_AT) : DEFAULT_ATTENDANCE_SWEEP_AT;
  return { kind: 'daily', at, days: 'workdays' };
}

export const attendanceSweepJob: JobDefinition = {
  name: 'attendance-sweep',
  perSpace: true,
  schedule: attendanceSweepSchedule,
  writes: 'business',
  timeoutMs: 5 * 60_000,
  async handler(ctx): Promise<JobResult> {
    if (!ctx.space) throw new Error('attendance-sweep: нужен контекст пространства');
    const r = await runAttendanceSweep(bookingDeps(), ctx.actor, { spaceId: ctx.space.id, now: ctx.now });
    ctx.log.info('attendance-sweep.run', { ...r });
    return { status: 'ok', stats: { ...r } };
  },
};
