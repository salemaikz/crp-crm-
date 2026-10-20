// Перевод epoch-мс ↔ местное время по IANA-поясу из настроек (`org.timezone`).
// Не зависит от TZ процесса: местное время берётся из Intl с явным `timeZone`, а не из Date#getHours.
// Переходы на летнее время в поясе установки не обязательны (в РК их нет), но обработаны:
// несуществующее местное время сдвигается вперёд за «дыру», неоднозначное — первое по времени.
import type { HHMM, IsoWeekday, LocalDay, LocalParts, Ms } from './types';

const MS_MINUTE = 60_000;
const MS_DAY = 86_400_000;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Бросает RangeError на неизвестный пояс: ошибка настройки не должна тихо давать UTC.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Проверка имени пояса: бросает RangeError, если Intl его не знает. */
export function assertTimeZone(timeZone: string): void {
  if (typeof timeZone !== 'string' || timeZone === '') throw new RangeError('Часовой пояс не задан');
  try {
    formatterFor(timeZone);
  } catch {
    throw new RangeError(`Неизвестный часовой пояс: ${timeZone}`);
  }
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Остаток от деления с неотрицательным результатом (для моментов до 1970 года). */
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** 'YYYY-MM-DD' из числовых частей. */
export function formatDay(year: number, month: number, dayOfMonth: number): LocalDay {
  return `${pad(year, 4)}-${pad(month)}-${pad(dayOfMonth)}`;
}

/** Разбор 'YYYY-MM-DD' в числа; несуществующая дата (2026-02-30) — ошибка. */
export function parseDay(day: LocalDay): { year: number; month: number; dayOfMonth: number } {
  const m = typeof day === 'string' ? DAY_RE.exec(day) : null;
  if (!m) throw new RangeError(`Дата должна быть YYYY-MM-DD: ${String(day)}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, dayOfMonth));
  check.setUTCFullYear(year); // годы 0–99 Date#UTC трактует как 1900–1999
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== dayOfMonth) {
    throw new RangeError(`Такой даты нет: ${day}`);
  }
  return { year, month, dayOfMonth };
}

export function isValidDay(day: unknown): day is LocalDay {
  if (typeof day !== 'string') return false;
  try {
    parseDay(day);
    return true;
  } catch {
    return false;
  }
}

/** 'HH:MM' → минуты от полуночи (0–1439). */
export function parseHHMM(hhmm: HHMM): number {
  const m = typeof hhmm === 'string' ? HHMM_RE.exec(hhmm) : null;
  if (!m) throw new RangeError(`Время должно быть HH:MM (00:00–23:59): ${String(hhmm)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatHHMM(minutes: number): HHMM {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Календарные сутки как UTC-полночь (для арифметики по датам; пояса тут нет). */
function dayStartUtc(day: LocalDay): number {
  const { year, month, dayOfMonth } = parseDay(day);
  const d = new Date(Date.UTC(year, month - 1, dayOfMonth));
  d.setUTCFullYear(year);
  return d.getTime();
}

/** День недели по ISO для даты календаря. */
export function isoWeekday(day: LocalDay): IsoWeekday {
  const dow = new Date(dayStartUtc(day)).getUTCDay();
  return (dow === 0 ? 7 : dow) as IsoWeekday;
}

/** Календарные сутки плюс `n` суток (n может быть отрицательным). Пояс не нужен: это арифметика по датам. */
export function addLocalDays(day: LocalDay, n: number): LocalDay {
  if (!Number.isInteger(n)) throw new RangeError(`Число суток должно быть целым: ${n}`);
  const d = new Date(dayStartUtc(day) + n * MS_DAY);
  return formatDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Местное время момента в поясе `timeZone`. */
export function toLocalTime(at: Ms, timeZone: string): LocalParts {
  if (!Number.isFinite(at)) throw new RangeError(`Момент должен быть числом: ${at}`);
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const v: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = Number(p.value);
  const year = v.year ?? 0;
  const month = v.month ?? 1;
  const dayOfMonth = v.day ?? 1;
  const hour = (v.hour ?? 0) % 24;
  const minute = v.minute ?? 0;
  const second = v.second ?? 0;
  const millisecond = mod(Math.trunc(at), 1000);
  const day = formatDay(year, month, dayOfMonth);
  return {
    day,
    year,
    month,
    dayOfMonth,
    hour,
    minute,
    second,
    millisecond,
    weekday: isoWeekday(day),
    msOfDay: ((hour * 60 + minute) * 60 + second) * 1000 + millisecond,
  };
}

/** Местные сутки момента. */
export function localDayOf(at: Ms, timeZone: string): LocalDay {
  return toLocalTime(at, timeZone).day;
}

/** Смещение пояса от UTC в мс на момент `at` (Asia/Almaty с 2024 года: +5 ч). */
export function utcOffsetMs(at: Ms, timeZone: string): number {
  const p = toLocalTime(at, timeZone);
  const wallSecondStart = dayStartUtc(p.day) + p.msOfDay - p.millisecond; // настенные часы, как будто это UTC
  return wallSecondStart - (Math.trunc(at) - p.millisecond);
}

/**
 * Местное время → epoch-мс. `msOfDay` — миллисекунды от местной полуночи по настенным часам.
 * Несуществующее время (дыра при переводе вперёд) даёт момент после дыры; неоднозначное — первое вхождение.
 */
export function fromLocalMsOfDay(day: LocalDay, msOfDay: number, timeZone: string): Ms {
  const naive = dayStartUtc(day) + msOfDay; // «как будто местное время — это UTC»
  const before = utcOffsetMs(naive - MS_DAY, timeZone);
  const after = utcOffsetMs(naive + MS_DAY, timeZone);
  const valid = [...new Set([naive - before, naive - after])].filter((t) => t + utcOffsetMs(t, timeZone) === naive);
  if (valid.length > 0) return Math.min(...valid);
  return naive - before;
}

/** Местное время суток 'HH:MM' на дату `day` → epoch-мс. */
export function fromLocalTime(day: LocalDay, hhmm: HHMM, timeZone: string): Ms {
  return fromLocalMsOfDay(day, parseHHMM(hhmm) * MS_MINUTE, timeZone);
}

/**
 * Плюс `days` календарных суток в поясе, то же местное время (с секундами и мс).
 * Отличается от `at + days·24ч` в поясах с переходом на летнее время.
 */
export function addCalendarDays(at: Ms, days: number, timeZone: string): Ms {
  const p = toLocalTime(at, timeZone);
  return fromLocalMsOfDay(addLocalDays(p.day, days), p.msOfDay, timeZone);
}
