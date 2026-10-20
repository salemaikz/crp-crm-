// Общее для тестов времени: настройки календаря из слоя kz и независимый от кода «оракул» времени.
import { read } from '../../helpers/sourceFiles';
import type { CalendarHoliday, CalendarSettings, HolidayKind } from '../../../packages/core/src/time';

/** Строка календаря в пресете: примечание обязательно (CONFIG §6.2). */
export interface PresetHoliday {
  date: string;
  kind: HolidayKind;
  note: string;
}

interface PresetDoc {
  meta: { key: string; version: string };
  global: { calendar: { holidays: PresetHoliday[] } };
}

export function loadKzPreset(): PresetDoc {
  return JSON.parse(read('presets/kz/preset.json')) as PresetDoc;
}

/** Настройки как у установки в РК: Asia/Almaty, пн–пт, 09:00–18:00 для часов и окна звонков, праздники слоя kz. */
export function kzSettings(extraHolidays: CalendarHoliday[] = []): CalendarSettings {
  return {
    timezone: 'Asia/Almaty',
    workdays: [1, 2, 3, 4, 5],
    workHours: { start: '09:00', end: '18:00' },
    callWindow: { start: '09:00', end: '18:00' },
    holidays: [...loadKzPreset().global.calendar.holidays, ...extraHolidays],
  };
}

const ALMATY_MS = 5 * 3_600_000;

/** 'YYYY-MM-DD HH:MM[:SS[.mmm]]' по Asia/Almaty (UTC+5 с 2024 года) → epoch-мс. Считается руками, без кода модуля. */
export function at(local: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?$/.exec(local);
  if (!m) throw new Error(`bad local time ${local}`);
  const [, y, mo, d, h, mi, s = '0', ms = '0'] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms)) - ALMATY_MS;
}

/** epoch-мс → 'YYYY-MM-DD HH:MM' по Asia/Almaty, для читаемых сообщений об ошибках. */
export function show(t: number): string {
  return new Date(t + ALMATY_MS).toISOString().slice(0, 16).replace('T', ' ');
}
