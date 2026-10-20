/**
 * Рабочий календарь для записи: «рабочий ли день» — внедряемая функция.
 *
 * Ядро не знает ни праздников, ни рабочей недели: их задают настройки
 * (`calendar.workdays`, `calendar.holidays`, CONFIG §6.2). Здесь только тонкая
 * арифметика над предикатом: сборка предиката из настроек, N-й рабочий день,
 * следующий рабочий день.
 */

import { addDays, isoWeekday } from './time';

/** Рабочий ли день ('YYYY-MM-DD'). Внедряется вызывающим кодом. */
export type IsWorkday = (date: string) => boolean;

/** Запись `calendar.holidays`: holiday — нерабочий, workday — перенесённый рабочий (суббота). */
export interface CalendarDay {
  date: string;
  kind: 'holiday' | 'workday';
}

/** Предикат из настроек: исключение по дате побеждает день недели. */
export function makeIsWorkday(workdays: readonly number[], days: readonly CalendarDay[] = []): IsWorkday {
  const byDate = new Map(days.map((d) => [d.date, d.kind] as const));
  const week = new Set(workdays);
  return (date) => {
    const kind = byDate.get(date);
    if (kind === 'holiday') return false;
    if (kind === 'workday') return true;
    return week.has(isoWeekday(date));
  };
}

/** Страховка от пустого календаря (ни одного рабочего дня): дальше этого горизонта не ищем. */
const MAX_SCAN_DAYS = 400;

/** Ближайший рабочий день строго после `date`. */
export function nextWorkday(date: string, isWorkday: IsWorkday): string {
  let d = date;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    d = addDays(d, 1);
    if (isWorkday(d)) return d;
  }
  throw new RangeError('[booking] в календаре нет рабочих дней');
}

/** Дата через `n` рабочих дней после `date` (n = 0 — сама дата, как есть). */
export function addWorkdays(date: string, n: number, isWorkday: IsWorkday): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextWorkday(d, isWorkday);
  return d;
}
