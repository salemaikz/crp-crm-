// Расписание: чистая функция slotFor (дизайн worker-design §2). Время и календарь — параметры.
import { time } from '@crm/core';
import type { DayFilter, Slot, SlotCalendar, SlotFor, ScheduleSpec } from './types';

const MS_MIN = 60_000;

function dayOk(days: DayFilter, day: string, cal: SlotCalendar): boolean {
  return days === 'all' || cal.isWorkday(day);
}

function positive(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`расписание: ${what} — целое число от 1`);
  return n;
}

function minuteSlot(day: string, minutes: number, tz: string): Slot {
  const hhmm = time.formatHHMM(minutes);
  return { key: `${day}T${hhmm}`, at: time.fromLocalTime(day, hhmm, tz) };
}

export const slotFor: SlotFor = (spec: ScheduleSpec, now, cal): Slot | null => {
  if (spec.kind === 'manual') return null;
  const tz = cal.timezone;
  const p = time.toLocalTime(now, tz);

  switch (spec.kind) {
    case 'daily': {
      if (!dayOk(spec.days, p.day, cal)) return null;
      const atMin = time.parseHHMM(spec.at);
      if (p.msOfDay < atMin * MS_MIN) return null;
      return { key: p.day, at: time.fromLocalTime(p.day, spec.at, tz) };
    }
    case 'times': {
      if (!dayOk(spec.days, p.day, cal)) return null;
      const passed = spec.at.map((t) => time.parseHHMM(t)).filter((m) => m * MS_MIN <= p.msOfDay);
      if (passed.length === 0) return null;
      return minuteSlot(p.day, Math.max(...passed), tz);
    }
    case 'grid': {
      positive(spec.everyMin, 'everyMin');
      if (!dayOk(spec.days, p.day, cal)) return null;
      const from = time.parseHHMM(spec.from);
      const to = time.parseHHMM(spec.to);
      const nowMin = p.msOfDay / MS_MIN;
      const capped = Math.min(nowMin, to);
      if (capped < from) return null;
      const point = from + Math.floor((capped - from) / spec.everyMin) * spec.everyMin;
      // Пропущенный тик не догоняется (D-171): с точки сетки прошло больше graceMin — слота нет
      if (p.msOfDay - point * MS_MIN > spec.graceMin * MS_MIN) return null;
      return minuteSlot(p.day, point, tz);
    }
    case 'interval': {
      const every = positive(spec.everyMin, 'everyMin');
      const minutes = Math.floor(p.msOfDay / MS_MIN);
      return minuteSlot(p.day, Math.floor(minutes / every) * every, tz);
    }
  }
};
