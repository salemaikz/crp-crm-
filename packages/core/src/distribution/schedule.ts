// Расписание раздачи (PROCESS 7.2). Исправление ошибки SalemAI: раздача шла ночью (на любое
// событие). Теперь тик допустим только в рабочий день и в окне `distribution.schedule`;
// приём по API раздачу не запускает.

import type { DistributionCalendar, DistributionSchedule, HHMM, Ms } from './types';

export function parseHHMM(value: HHMM): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  if (!m || h > 23 || min > 59) throw new Error(`Некорректное время «${value}», ожидается HH:MM`);
  return h * 60 + min;
}

/** Последний тик дня: from + k·everyMin ≤ to. */
export function lastTickMinutes(s: DistributionSchedule): number {
  const from = parseHHMM(s.from);
  const to = parseHHMM(s.to);
  const step = Math.max(1, Math.floor(s.everyMin));
  return to < from ? from : from + Math.floor((to - from) / step) * step;
}

/** День подходит для раздачи (рабочий, если `workdaysOnly`). */
export function isDistributionDay(at: Ms, cal: DistributionCalendar, s: DistributionSchedule): boolean {
  return !s.workdaysOnly || cal.isWorkday(cal.localDay(at));
}

/** Момент внутри окна раздачи: подходящий день и `from ≤ время ≤ to`. */
export function isInDistributionWindow(at: Ms, cal: DistributionCalendar, s: DistributionSchedule): boolean {
  if (!isDistributionDay(at, cal, s)) return false;
  const t = cal.localMinutes(at);
  return t >= parseHHMM(s.from) && t <= parseHHMM(s.to);
}

/** Момент точно на сетке тиков (`from`, `from + everyMin`, … ≤ `to`). */
export function isTickTime(at: Ms, cal: DistributionCalendar, s: DistributionSchedule): boolean {
  if (!isInDistributionWindow(at, cal, s)) return false;
  return (cal.localMinutes(at) - parseHHMM(s.from)) % Math.max(1, Math.floor(s.everyMin)) === 0;
}

/** Раздача сегодня закончилась: нерабочий день или последний тик уже прошёл. */
export function isDistributionOver(at: Ms, cal: DistributionCalendar, s: DistributionSchedule): boolean {
  if (!isDistributionDay(at, cal, s)) return true;
  return cal.localMinutes(at) > lastTickMinutes(s);
}

/** Следующие `count` рабочих дней строго после `day`. */
export function workdaysAfter(day: string, count: number, cal: DistributionCalendar): string[] {
  const out: string[] = [];
  let d = day;
  for (let i = 0; i < count; i++) {
    d = cal.nextWorkday(d);
    out.push(d);
  }
  return out;
}
