// Срок перезвона воронки v2 на устройстве (pipeline-v2 §4.2): подсказка по номеру касания, быстрые даты, сборка
// пары «момент + точность». Ядро в браузер не попадает (D-101), поэтому правило шага повторено здесь;
// решающий расчёт и проверка — на сервере. Время приходит параметром.
import { nextWorkday } from './callback';
import type { CallCalendar } from './types';
import { addDays, fromLocal, localDay, type LocalDay } from './zoned';

export type CallbackPrecision = 'time' | 'day';

export interface ScheduleStep {
  days: number;
  /** `HH:MM`; нет — «в течение дня». */
  time: string | null;
}

const STEP = /^\+([1-9]\d{0,2})d(?:@([01]\d|2[0-3]):([0-5]\d))?$/;

/** Шаг `+Nd` или `+Nd@HH:MM`; иное → null. */
export function parseScheduleStep(step: string): ScheduleStep | null {
  const m = STEP.exec(step);
  if (!m) return null;
  const days = Number(m[1]);
  if (days > 365) return null;
  return { days, time: m[2] === undefined ? null : `${m[2]}:${m[3]}` };
}

export interface ScheduleHint {
  /** Номер касания, с 1. */
  touch: number;
  days: number;
  /** Местный день срока: через `days` суток, нерабочий — следующий рабочий. */
  day: LocalDay;
  precision: CallbackPrecision;
  /** Время шага; у точности «день» null. */
  time: string | null;
}

/**
 * Подсказка срока: касание k = перезвонов уже было + 1, шаг = steps[min(k, длина) − 1]. Пустой список или
 * неверный шаг — null (подсказки нет, остаются быстрые кнопки).
 */
export function scheduleHint(args: { steps: readonly string[]; touches: number; now: number; tz: string; cal: CallCalendar }): ScheduleHint | null {
  const { steps, tz, cal } = args;
  if (steps.length === 0) return null;
  const touch = Math.max(0, Math.trunc(args.touches)) + 1;
  const step = parseScheduleStep(steps[Math.min(touch, steps.length) - 1]!);
  if (!step) return null;
  const day = nextWorkday(addDays(localDay(args.now, tz), step.days - 1), cal);
  return { touch, days: step.days, day, precision: step.time === null ? 'day' : 'time', time: step.time };
}

/** «Завтра» — ближайший рабочий день; «Через неделю» — рабочий день не раньше чем через 7 суток. */
export function quickDay(kind: 'tomorrow' | 'week', now: number, tz: string, cal: CallCalendar): LocalDay {
  const today = localDay(now, tz);
  return kind === 'tomorrow' ? nextWorkday(today, cal) : nextWorkday(addDays(today, 6), cal);
}

/** Срок для дня: с временем — точность «время»; без — начало окна звонков и точность «день». */
export function dueFor(day: LocalDay, time: string | null, windowStart: string, tz: string): { at: number; precision: CallbackPrecision } {
  return time === null ? { at: fromLocal(day, windowStart, tz), precision: 'day' } : { at: fromLocal(day, time, tz), precision: 'time' };
}

/**
 * Срок по касанию, выбранный сразу (ui-polish §9.3, B4): подсказка — единственный разумный срок по умолчанию, оператору
 * остаётся поменять его, а не искать. Нет расписания или флага — null (срок выбирает человек).
 */
export function defaultDue(args: { steps: readonly string[] | null; touches: number | undefined; now: number; tz: string; cal: CallCalendar; windowStart: string }): { at: number; precision: CallbackPrecision } | null {
  if (!args.steps || args.touches === undefined) return null;
  const hint = scheduleHint({ steps: args.steps, touches: args.touches, now: args.now, tz: args.tz, cal: args.cal });
  return hint ? dueFor(hint.day, hint.time, args.windowStart, args.tz) : null;
}
