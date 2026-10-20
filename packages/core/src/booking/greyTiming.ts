/**
 * Когда «серую» запись консультации (без консультанта) подхватит прогон автоназначения.
 * Нужно, чтобы мастер записи и диалог «Записей» говорили правду, а не «утром» всегда.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/greyTiming.ts. Константы GREY_FIRST_RUN,
 * GREY_LAST_RUN, GREY_RUN_STEP_MIN уехали в настройки `booking.grey.schedule {first, last, stepMin}`.
 *
 * Прогоны идут по местному времени (`org.timezone`): в `first` — все «серые» дня, затем каждые
 * `stepMin` минут до `last` — только новые, и только на записи сегодняшнего дня:
 *   • день позже сегодняшнего — его прогон в `first`: first_run;
 *   • сегодня до `first` — тоже прогон в `first`: first_run;
 *   • сегодня с `first` до последнего прогона — ближайший шаговый прогон: next_run;
 *   • сегодня с последнего прогона (и прошедший день) — прогонов больше нет: too_late,
 *     консультанта можно назначить только вручную.
 */

import type { GreySchedule } from './types';
import { epochToLocalDate, epochToLocalTime, localToEpoch, minToTime, timeToMin, type Tz } from './time';

export type GreyTiming = 'first_run' | 'next_run' | 'too_late';

/** Времена прогонов дня: first, first+step, … , не позже last. */
export function greyRunTimes(schedule: GreySchedule): string[] {
  const first = timeToMin(schedule.first);
  const last = timeToMin(schedule.last);
  if (schedule.stepMin <= 0 || last < first) return [schedule.first];
  const out: string[] = [];
  for (let t = first; t <= last; t += schedule.stepMin) out.push(minToTime(t));
  return out;
}

/** Ближайший прогон строго после `now` в тот же местный день или null, если прогонов больше нет. */
export function nextGreyRunAt(now: number, schedule: GreySchedule, tz: Tz): number | null {
  const today = epochToLocalDate(tz, now);
  for (const t of greyRunTimes(schedule)) {
    const at = localToEpoch(tz, today, t);
    if (at > now) return at;
  }
  return null;
}

/**
 * Когда подберут консультанта «серой» записи на дату `date`, если записать её сейчас.
 * `isWorkday` — рабочий календарь: в праздник и выходной прогонов нет, поэтому first_run там
 * не обещается — ответ too_late (консультанта назначат вручную). Без календаря дата считается рабочей.
 * Последний прогон — последнее из `greyRunTimes` (если шаг не делит отрезок, это не `last`).
 */
export function greyTiming(
  date: string,
  now: number,
  schedule: GreySchedule,
  tz: Tz,
  isWorkday?: (date: string) => boolean,
): GreyTiming {
  const today = epochToLocalDate(tz, now);
  if (date < today) return 'too_late';
  if (isWorkday && !isWorkday(date)) return 'too_late';
  if (date > today) return 'first_run';
  const min = timeToMin(epochToLocalTime(tz, now));
  const runs = greyRunTimes(schedule).map(timeToMin);
  if (min < runs[0]!) return 'first_run';
  if (min < runs[runs.length - 1]!) return 'next_run';
  return 'too_late';
}
