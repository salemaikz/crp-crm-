// Синтетические данные для тестов ядра записи: имена и телефоны выдуманы.
import type { Consultant, ScheduleWindow, SlotBooking } from './types';
import type { ConsultantSchedule, DaySnapshot } from './daySnapshot';

export const TZ = 'Asia/Almaty';
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const MONDAY = '2026-10-19';
export const THURSDAY = '2026-10-22';

export function consultant(id: string, p: Partial<Consultant> = {}): Consultant {
  return {
    id, name: id, directions: [], slotMin: 45, capacity: 1, usesSchedule: false, autoAssign: true, active: true, sort: 0, ...p,
  };
}

export function booking(id: string, consultantId: string | null, startTime: string, p: Partial<SlotBooking> = {}): SlotBooking {
  return { id, consultantId, startTime, durationMin: 45, isReserve: false, createdAt: 0, directionKey: '', ...p };
}

/** Понедельник 11:00–13:00: слоты по 45 минут — 11:00 и 11:45. */
export const MONDAY_11_13: ScheduleWindow[] = [{ weekday: 1, start: '11:00', end: '13:00' }];
/** Понедельник 10:00–14:00: слоты 10:00, 10:45, 11:30, 12:15, 13:00. */
export const MONDAY_10_14: ScheduleWindow[] = [{ weekday: 1, start: '10:00', end: '14:00' }];

export function snapshot(
  consultants: Consultant[],
  bookings: SlotBooking[] = [],
  schedules: Record<string, ConsultantSchedule> = {},
  date = MONDAY,
): DaySnapshot {
  return {
    date,
    hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
    consultants: consultants.filter((c) => c.active),
    schedules: new Map(Object.entries(schedules)),
    bookings,
  };
}
