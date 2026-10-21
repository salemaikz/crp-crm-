// Белый список путей настроек, доступных из интерфейса (R2b, D-267), и схемы тела запросов.
// Чистый модуль: без БД и Next. Всё вне списка из интерфейса не меняется — ни роли, ни воронки, ни поля.
import { z } from 'zod';

/** Пути, которые правит РОП с правом `settings.sales`. Область: пространство или global. */
export const SALES_PATHS = [
  { path: 'distribution.dailyCap', scope: 'space' },
  { path: 'distribution.schedule.from', scope: 'space' },
  { path: 'distribution.schedule.to', scope: 'space' },
  { path: 'distribution.schedule.everyMin', scope: 'space' },
  { path: 'calendar.callWindow.start', scope: 'global' },
  { path: 'calendar.callWindow.end', scope: 'global' },
  { path: 'reports.callsPerHourTarget', scope: 'space' },
] as const;

/** Путь правит только администратор. */
export const HOLIDAYS_PATH = 'calendar.holidays';

export const EVERY_MIN_VALUES = [15, 30, 60, 120] as const;
export const HOLIDAYS_MAX = 300;
export const HOLIDAY_NOTE_MAX = 100;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Rev = z.number().int().min(0);

/** Календарная дата `YYYY-MM-DD`, существующая в календаре. */
const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  });

export const SalesPatch = z
  .object({
    dailyCap: z.number().int().min(0).max(500),
    schedule: z
      .object({ from: HHMM, to: HHMM, everyMin: z.union([z.literal(15), z.literal(30), z.literal(60), z.literal(120)]) })
      .partial()
      .strict(),
    callWindow: z.object({ start: HHMM, end: HHMM }).partial().strict(),
    callsPerHourTarget: z.number().int().min(1).max(100).nullable(),
  })
  .partial()
  .strict();
export type SalesPatch = z.infer<typeof SalesPatch>;

export const SalesPatchInput = z
  .object({
    expectedRev: z.object({ global: Rev, space: Rev }).strict(),
    patch: SalesPatch,
  })
  .strict();
export type SalesPatchInput = z.infer<typeof SalesPatchInput>;

export const Holiday = z
  .object({ date: LocalDate, kind: z.enum(['holiday', 'workday']), note: z.string().max(HOLIDAY_NOTE_MAX) })
  .strict();
export type Holiday = z.infer<typeof Holiday>;

export const HolidaysInput = z
  .object({
    expectedRev: z.object({ global: Rev }).strict(),
    holidays: z
      .array(Holiday)
      .max(HOLIDAYS_MAX)
      .refine((a) => new Set(a.map((h) => h.date)).size === a.length, 'дата уникальна'),
  })
  .strict();
export type HolidaysInput = z.infer<typeof HolidaysInput>;

/** Перечень изменяемых путей патча (для `note` ревизии и проверки белого списка). */
export function patchPaths(patch: SalesPatch): string[] {
  const out: string[] = [];
  if (patch.dailyCap !== undefined) out.push('distribution.dailyCap');
  for (const k of ['from', 'to', 'everyMin'] as const) if (patch.schedule?.[k] !== undefined) out.push(`distribution.schedule.${k}`);
  for (const k of ['start', 'end'] as const) if (patch.callWindow?.[k] !== undefined) out.push(`calendar.callWindow.${k}`);
  if (patch.callsPerHourTarget !== undefined) out.push('reports.callsPerHourTarget');
  return out;
}

export type PatchIssue = { path: string };

/** Проверки, которым нужны итоговые значения (`from < to`, `start < end`). Пути — как в патче. */
export function crossIssues(next: { from: string; to: string; start: string; end: string }, patch: SalesPatch): PatchIssue[] {
  const issues: PatchIssue[] = [];
  if ((patch.schedule?.from !== undefined || patch.schedule?.to !== undefined) && next.from >= next.to) issues.push({ path: 'schedule.to' });
  if ((patch.callWindow?.start !== undefined || patch.callWindow?.end !== undefined) && next.start >= next.end) issues.push({ path: 'callWindow.end' });
  return issues;
}
