/**
 * Серии групповых мероприятий: какие мероприятия нужны на горизонте и что поменять в уже созданных.
 *
 * Новая логика по PROCESS §5.1 (в SalemAI серия раскладывалась SQL-ом при открытии страницы).
 * Здесь только решения; вставки и удаления делает job `events-ensure`:
 *   • генерация идёт по горизонту `booking.horizonDays` от сегодняшней местной даты, по расписанию
 *     задачи, а не при открытии страницы;
 *   • праздники и нерабочие дни из календаря (внедряемая функция `isWorkday`) пропускаются,
 *     пропуски возвращаются отдельно — РОП видит их на экране серии и может создать разовое
 *     мероприятие на другой день;
 *   • идемпотентность — `occurrenceKey` (UNIQUE): повторный прогон ничего не создаёт;
 *   • правка серии перегенерирует только НЕТРОНУТЫЕ будущие мероприятия: без записей, дежурных
 *     и ручных правок. Отменённое мероприятие не «возвращается»: его ключ уже занят.
 */

import type { EventLite, EventSeries } from './types';
import { addDays, epochToLocalDate, isoWeekday, localToEpoch, type Tz } from './time';
import type { IsWorkday } from './calendar';

export interface Occurrence {
  occurrenceKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
}

export interface SkippedOccurrence {
  date: string;
  reason: 'non_workday';
}

export interface OccurrenceOptions {
  tz: Tz;
  now: number;
  horizonDays: number;
  isWorkday: IsWorkday;
}

export function occurrenceKey(seriesId: string, eventDate: string): string {
  return `${seriesId}:${eventDate}`;
}

/** Мероприятия серии на горизонте [сегодня, сегодня + horizonDays) и пропущенные из-за календаря даты. */
export function seriesOccurrences(
  series: EventSeries,
  opts: OccurrenceOptions,
): { occurrences: Occurrence[]; skipped: SkippedOccurrence[] } {
  const occurrences: Occurrence[] = [];
  const skipped: SkippedOccurrence[] = [];
  if (!series.active) return { occurrences, skipped };
  const today = epochToLocalDate(opts.tz, opts.now);
  for (let i = 0; i < opts.horizonDays; i++) {
    const date = addDays(today, i);
    if (isoWeekday(date) !== series.weekday) continue;
    const startsAt = localToEpoch(opts.tz, date, series.startTime);
    if (startsAt <= opts.now) continue; // сегодняшнее, но уже начавшееся
    if (!opts.isWorkday(date)) {
      skipped.push({ date, reason: 'non_workday' });
      continue;
    }
    occurrences.push({
      occurrenceKey: occurrenceKey(series.id, date),
      eventDate: date,
      startTime: series.startTime,
      startsAt,
      durationMin: series.durationMin,
      location: series.location,
      format: series.format,
      capacity: series.capacity,
    });
  }
  return { occurrences, skipped };
}

/** Существующее мероприятие серии с признаками «тронутости». */
export interface ExistingEvent extends EventLite {
  bookingCount: number;
  dutyCount: number;
}

export type OccurrenceChange = Partial<Pick<Occurrence, 'startTime' | 'startsAt' | 'durationMin' | 'location' | 'format' | 'capacity'>>;

export interface SeriesSyncPlan {
  create: Occurrence[];
  update: { id: string; changes: OccurrenceChange }[];
  /** Нетронутые будущие мероприятия, которых серия больше не порождает (день недели сменился, праздник). */
  remove: string[];
  skipped: SkippedOccurrence[];
}

/** Нетронутое: можно перегенерировать без последствий для людей. */
function isUntouched(e: ExistingEvent, now: number): boolean {
  return e.status === 'scheduled' && !e.touched && e.bookingCount === 0 && e.dutyCount === 0 && e.startsAt > now;
}

/** План синхронизации серии с уже созданными мероприятиями (`existing` — только этой серии). */
export function planSeriesSync(series: EventSeries, existing: readonly ExistingEvent[], opts: OccurrenceOptions): SeriesSyncPlan {
  const { occurrences, skipped } = seriesOccurrences(series, opts);
  const byKey = new Map<string, ExistingEvent>();
  for (const e of existing) if (e.occurrenceKey) byKey.set(e.occurrenceKey, e);

  const create: Occurrence[] = [];
  const update: SeriesSyncPlan['update'] = [];
  for (const occ of occurrences) {
    const cur = byKey.get(occ.occurrenceKey);
    if (!cur) {
      create.push(occ);
      continue;
    }
    if (!isUntouched(cur, opts.now)) continue;
    const changes: OccurrenceChange = {};
    if (cur.startTime !== occ.startTime) {
      changes.startTime = occ.startTime;
      changes.startsAt = occ.startsAt;
    } else if (cur.startsAt !== occ.startsAt) {
      changes.startsAt = occ.startsAt;
    }
    if (cur.durationMin !== occ.durationMin) changes.durationMin = occ.durationMin;
    if (cur.location !== occ.location) changes.location = occ.location;
    if (cur.format !== occ.format) changes.format = occ.format;
    if (cur.capacity !== occ.capacity) changes.capacity = occ.capacity;
    if (Object.keys(changes).length > 0) update.push({ id: cur.id, changes });
  }

  // Удаляем лишнее только внутри горизонта: за его пределами мероприятия ещё не «наши».
  const wanted = new Set(occurrences.map((o) => o.occurrenceKey));
  const today = epochToLocalDate(opts.tz, opts.now);
  const last = addDays(today, opts.horizonDays - 1);
  const remove = existing
    .filter((e) => e.eventDate >= today && e.eventDate <= last)
    .filter((e) => !e.occurrenceKey || !wanted.has(e.occurrenceKey))
    .filter((e) => isUntouched(e, opts.now))
    .map((e) => e.id);

  return { create, update, remove, skipped };
}
