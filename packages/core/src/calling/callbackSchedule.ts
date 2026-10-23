// Срок перезвона по номеру касания (pipeline-v2 §4.2, `calling.callbackSchedule.steps`).
// Чистая логика: время и календарь приходят параметрами. Шаги: `+Nd` (точность «день»,
// N от 1 до 365) и `+Nd@HH:MM` (точность «время»).

import type { CallbackPrecision, HHMM, Ms, WorkCalendar } from './spec/types.js';

export interface CallbackStep {
  /** Календарные сутки вперёд. */
  days: number;
  /** Время суток; нет — «в течение дня». */
  hhmm: HHMM | null;
}

const STEP = /^\+([1-9]\d{0,2})d(?:@([01]\d|2[0-3]):([0-5]\d))?$/;

/** Разбор шага; `null` — формат неверный или N вне 1..365. */
export function parseCallbackStep(step: string): CallbackStep | null {
  const m = STEP.exec(step);
  if (!m) return null;
  const days = Number(m[1]);
  if (days < 1 || days > 365) return null;
  return { days, hhmm: m[2] === undefined ? null : `${m[2]}:${m[3]}` };
}

export interface CallbackDue {
  at: Ms;
  precision: CallbackPrecision;
}

/** Шаг для касания `k` (с 1): `steps[min(k, len) − 1]`; четвёртое и далее повторяют последний шаг. */
export function stepForTouch(steps: readonly string[], k: number): string {
  if (steps.length === 0) throw new RangeError('calling.callbackSchedule.steps пуст');
  return steps[Math.min(Math.max(k, 1), steps.length) - 1]!;
}

/**
 * Срок для касания `touchK` (1 — первое). Через N календарных суток от `now`; нерабочий день —
 * следующий рабочий. Без времени — начало окна звонков, точность `day`.
 */
export function resolveCallbackDue(steps: readonly string[], touchK: number, now: Ms, cal: WorkCalendar): CallbackDue {
  const raw = stepForTouch(steps, touchK);
  const step = parseCallbackStep(raw);
  if (!step) throw new RangeError(`calling.callbackSchedule: неверный шаг «${raw}»`);
  const hhmm = step.hhmm ?? cal.callWindowStart;
  // Первый рабочий день строго после суток `now + N − 1`, то есть сутки `now + N` или ближайший рабочий после них.
  const at = cal.nextWorkdayAt(cal.addDays(now, step.days - 1), hhmm);
  return { at, precision: step.hhmm === null ? 'day' : 'time' };
}
