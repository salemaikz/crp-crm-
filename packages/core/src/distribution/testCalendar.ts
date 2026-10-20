// Тестовый календарь раздачи: Asia/Almaty (UTC+5), пн–пт, 26.10.2026 — выходной (перенос).
// Собран тем же `core/time`, что и боевой, через адаптер.

import { createWorkCalendar } from '../time';
import { toDistributionCalendar } from './calendar';
import type { Ms } from './types';

const OFFSET = 5 * 3600_000;
const hours = { start: '09:00', end: '18:00' };

export const TEST_CALENDAR = toDistributionCalendar(
  createWorkCalendar({
    timezone: 'Asia/Almaty',
    workdays: [1, 2, 3, 4, 5],
    workHours: hours,
    callWindow: hours,
    holidays: [{ date: '2026-10-26', kind: 'holiday' }],
  }),
);

/** 'YYYY-MM-DD HH:MM' местного времени → epoch-мс. */
export function at(local: string): Ms {
  return Date.parse(`${local.replace(' ', 'T')}:00Z`) - OFFSET;
}
