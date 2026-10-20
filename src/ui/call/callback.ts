// Быстрые сроки перезвона: «+2 ч», «следующий рабочий день 10:00» (PROCESS 2.6). Считаются на устройстве по
// настройкам, которые пришли со страницей; итоговую проверку (не в прошлом, окно звонков) делает сервер.
import type { CallCalendar, CallbackPreset } from './types';
import { addDays, fromLocal, isoWeekday, localDay } from './zoned';

function isWorkday(day: string, cal: CallCalendar): boolean {
  const h = cal.holidays.find((x) => x.date === day);
  if (h) return h.kind === 'workday';
  return cal.workdays.includes(isoWeekday(day));
}

/** Ближайший рабочий день после `day` (до двух недель вперёд; нет — следующий день). */
export function nextWorkday(day: string, cal: CallCalendar): string {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(day, i);
    if (isWorkday(d, cal)) return d;
  }
  return addDays(day, 1);
}

export interface ResolvedPreset {
  preset: CallbackPreset;
  at: number;
  /** 'plus' — относительный срок; 'tomorrow' — завтра; 'day' — другой день недели (подпись по `at`). */
  shape: 'plus' | 'tomorrow' | 'day';
}

/** Момент для шага настроек от `now`. */
export function resolvePreset(preset: CallbackPreset, now: number, tz: string, cal: CallCalendar): ResolvedPreset {
  if (preset.kind === 'plus') return { preset, at: now + preset.minutes * 60_000, shape: 'plus' };
  const today = localDay(now, tz);
  const day = nextWorkday(today, cal);
  return { preset, at: fromLocal(day, preset.time, tz), shape: day === addDays(today, 1) ? 'tomorrow' : 'day' };
}

export function resolvePresets(presets: readonly CallbackPreset[], now: number, tz: string, cal: CallCalendar): ResolvedPreset[] {
  return presets.map((p) => resolvePreset(p, now, tz, cal));
}
