// Период отчёта (D-261): разбор местных дней в границы [fromMs, toMs), неделя с понедельника, корзины.
// Чистые функции без БД: границы суток считает ядро (time) по поясу установки.
import { time } from '@crm/core';
import { BadRequestError } from '@/server/access';
import { MAX_PERIOD_DAYS, type Grouping, type PeriodInput, type ResolvedPeriod } from './reportTypes';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

function invalid(): never {
  throw new BadRequestError('period_invalid');
}

/** Разница в сутках между двумя местными днями (арифметика по датам, без пояса). */
export function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_DAY);
}

/**
 * Разбор периода: формат, `from <= to`, длина не больше 92 дней, `to` не позже завтрашнего дня.
 * `now` нужен для проверки будущего; без него проверка пропускается (тесты границ).
 */
export function resolvePeriod(input: PeriodInput, timeZone: string, now?: number): ResolvedPeriod {
  const { from, to } = input;
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY_RE.test(from) || !DAY_RE.test(to)) invalid();
  if (!time.isValidDay(from) || !time.isValidDay(to)) invalid();
  if (from > to) invalid();
  const days = diffDays(from, to) + 1;
  if (days > MAX_PERIOD_DAYS) invalid();
  if (now !== undefined) {
    const tomorrow = time.addLocalDays(time.localDayOf(now, timeZone), 1);
    if (to > tomorrow) invalid();
  }
  return {
    from,
    to,
    fromMs: time.fromLocalTime(from, '00:00', timeZone),
    toMs: time.fromLocalTime(time.addLocalDays(to, 1), '00:00', timeZone),
    timeZone,
    days,
  };
}

/** Понедельник недели (ISO), в которую входит день. */
export function weekOf(day: string): string {
  return time.addLocalDays(day, 1 - time.isoWeekday(day));
}

/** Текущая неделя по умолчанию: понедельник … сегодня. */
export function defaultPeriod(today: string): PeriodInput {
  return { from: weekOf(today), to: today };
}

/** Прошлая неделя целиком: понедельник … воскресенье перед текущей. */
export function previousWeek(today: string): PeriodInput {
  const monday = weekOf(today);
  return { from: time.addLocalDays(monday, -7), to: time.addLocalDays(monday, -1) };
}

/** Ключ корзины: 'total', день или понедельник недели. */
export function bucketOf(day: string, grouping: Grouping): string {
  if (grouping === 'total') return 'total';
  if (grouping === 'day') return day;
  return weekOf(day);
}
