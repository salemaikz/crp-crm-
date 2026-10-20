// Рабочий календарь установки из активных настроек (документ global) — для расписания воркера.
import { time } from '@crm/core';
import type { ActiveConfig } from '@crm/core/config';

export function calendarFromConfig(cfg: ActiveConfig): time.WorkCalendar {
  const g = cfg.global.doc;
  const c = g.calendar;
  return time.createWorkCalendar({
    timezone: g.org.timezone,
    workdays: c.workdays,
    workHours: { start: c.workHours.start, end: c.workHours.end },
    callWindow: { start: c.callWindow.start, end: c.callWindow.end },
    holidays: c.holidays.map((h) => ({ date: h.date, kind: h.kind, ...(h.note !== undefined ? { note: h.note } : {}) })),
  });
}
