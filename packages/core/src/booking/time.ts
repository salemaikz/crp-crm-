/**
 * Местное время записей. Пояс приходит параметром (`org.timezone`, IANA), а не константой.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/time.ts. Там смещение было зашито (UTC+5);
 * здесь оно берётся из Intl для заданного пояса, поэтому пояс процесса (сервер в UTC,
 * браузер где угодно) ни на что не влияет. Тесты гоняются при TZ=UTC и TZ=Asia/Almaty.
 *
 * Никакого new Date('YYYY-MM-DD') и new Date(y, m, d): первый читает дату как полночь UTC,
 * второй — как полночь в поясе процесса. Календарная арифметика по строкам дат — только
 * через Date.UTC и UTC-геттеры.
 *
 * Арифметика поясов и дат — не своя: всё делегируется `../time/zone` (один календарь на ядро).
Здесь остаются имена и сигнатуры, которыми пользуется домен записи.

Модуль чистый: Date.now() не вызывается, время приходит параметром.
 */

import {
  addLocalDays,
  assertTimeZone,
  formatHHMM,
  fromLocalMsOfDay,
  isoWeekday as zoneIsoWeekday,
  isValidDay,
  localDayOf,
  toLocalTime,
  utcOffsetMs,
} from '../time';

export type Tz = string;

const MS_MINUTE = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Известен ли пояс рантайму (для проверки настроек). */
export function isValidTimezone(tz: string): boolean {
  try {
    assertTimeZone(tz);
    return true;
  } catch {
    return false;
  }
}

/** Смещение пояса от UTC в миллисекундах в данный момент (восточнее UTC — положительное). */
export function tzOffsetMs(tz: Tz, instantMs: number): number {
  return utcOffsetMs(Math.floor(instantMs / 1000) * 1000, tz);
}

/** 'YYYY-MM-DD', существующая дата (30 февраля — нет); годы без ограничения. */
export function isLocalDate(value: string): boolean {
  return isValidDay(value);
}

/** 'HH:MM' в 24-часовом формате. */
export function isLocalTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minToTime(min: number): string {
  return formatHHMM(min);
}

/** Проверка даты с понятной ошибкой домена записи. */
function checked(date: string): string {
  if (!isValidDay(date)) throw new RangeError(`[booking] ожидалась дата YYYY-MM-DD: ${date}`);
  return date;
}

/** Момент (epoch ms) для местных даты и времени в поясе `tz`. */
export function localToEpoch(tz: Tz, date: string, time: string): number {
  return fromLocalMsOfDay(checked(date), timeToMin(time) * MS_MINUTE, tz);
}

/** Местная дата момента. */
export function epochToLocalDate(tz: Tz, ms: number): string {
  return localDayOf(ms, tz);
}

/** Местное время 'HH:MM' момента. */
export function epochToLocalTime(tz: Tz, ms: number): string {
  const p = toLocalTime(ms, tz);
  return formatHHMM(p.hour * 60 + p.minute);
}

/** Начало местных суток даты (epoch ms). */
export function localDayStart(tz: Tz, date: string): number {
  return localToEpoch(tz, date, '00:00');
}

export function addDays(date: string, n: number): string {
  return addLocalDays(checked(date), n);
}

/** ISO-день недели 1..7 (Пн..Вс). */
export function isoWeekday(date: string): number {
  return zoneIsoWeekday(checked(date));
}

/** Понедельник недели, в которую попадает дата. */
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Ближайшая дата с данным днём недели, начиная с `from` включительно. */
export function nextWeekday(from: string, weekday: number): string {
  const diff = (weekday - isoWeekday(from) + 7) % 7;
  return addDays(from, diff);
}
