// Тестовый календарь раздачи: UTC+5 без перехода на летнее время, рабочие пн–пт, 26.10.2026 — выходной
// (перенос). Нужен только тестам; боевой календарь — `core/time`.

import type { DistributionCalendar, LocalDay, Ms } from './types';

const OFFSET = 5 * 3600_000;
const DAY = 86400_000;
const HOLIDAYS = new Set<LocalDay>(['2026-10-26']);

const dayOf = (at: Ms): LocalDay => new Date(at + OFFSET).toISOString().slice(0, 10);
const dow = (day: LocalDay): number => new Date(`${day}T00:00:00Z`).getUTCDay();

export const TEST_CALENDAR: DistributionCalendar = {
  localDay: dayOf,
  localMinutes: (at) => {
    const d = new Date(at + OFFSET);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  },
  isWorkday: (day) => dow(day) >= 1 && dow(day) <= 5 && !HOLIDAYS.has(day),
  nextWorkday: (day) => {
    let t = Date.parse(`${day}T00:00:00Z`);
    do t += DAY;
    while (!TEST_CALENDAR.isWorkday(new Date(t).toISOString().slice(0, 10)));
    return new Date(t).toISOString().slice(0, 10);
  },
};

/** 'YYYY-MM-DD HH:MM' местного времени → epoch-мс. */
export function at(local: string): Ms {
  return Date.parse(`${local.replace(' ', 'T')}:00Z`) - OFFSET;
}
