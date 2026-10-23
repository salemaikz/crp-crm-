// Группы по сроку (PROCESS 6.3): границы — начало местных суток в поясе установки, «просрочено» — срок прошёл,
// задача открыта. Чистые функции: границы считает вызывающий от `viewer.now` и `viewer.today`.
import { time } from '@crm/core';
import type { TaskBucket } from './types';

/** `todayStart` — начало сегодняшних местных суток: срок «день» просрочен, только если он раньше (pipeline-v2 §4.3). */
export type DayBounds = { now: number; todayStart: number; tomorrowStart: number; afterTomorrowStart: number };

/** Начала завтрашних и послезавтрашних местных суток для `today` в поясе `tz`. */
export function dayBounds(now: number, today: string, tz: string): DayBounds {
  return {
    now,
    todayStart: time.fromLocalTime(today, '00:00', tz),
    tomorrowStart: time.fromLocalTime(time.addLocalDays(today, 1), '00:00', tz),
    afterTomorrowStart: time.fromLocalTime(time.addLocalDays(today, 2), '00:00', tz),
  };
}

/** Просрочена ли открытая задача: «время» — срок прошёл, «день» — наступили следующие сутки. */
export function isTaskOverdue(dueAt: number, precision: 'time' | 'day', b: DayBounds): boolean {
  return precision === 'day' ? dueAt < b.todayStart : dueAt < b.now;
}

export function bucketOf(dueAt: number | null, precision: 'time' | 'day', b: DayBounds): TaskBucket {
  if (dueAt === null) return 'none';
  if (isTaskOverdue(dueAt, precision, b)) return 'overdue';
  if (dueAt < b.tomorrowStart) return 'today';
  if (dueAt < b.afterTomorrowStart) return 'tomorrow';
  return 'later';
}

/** Срок вне рабочих часов рабочего дня — предупреждение, не запрет (PROCESS 6.3). */
export function dueOutsideWork(dueAt: number | null, calendar: Pick<time.WorkCalendar, 'isWorkingMoment'>): boolean {
  return dueAt !== null && !calendar.isWorkingMoment(dueAt);
}
