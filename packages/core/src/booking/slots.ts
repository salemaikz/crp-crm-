/**
 * Движок слотов консультаций: чистые функции, без БД.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/slots.ts (`effectiveDay`, `workWindows`,
 * `slotStarts`, `countOverlapping`, `buildSlots`, `fitsPlan`, `intervalsToDay`).
 *
 * Модель графика — как в схеме v1: недельные окна (перерыв = промежуток между окнами)
 * и исключения на дату (`off` — выходной/отпуск, `custom` — особые окна). Исключение
 * на дату одно (UNIQUE (resource_id, day)), поэтому приоритетов между ними нет.
 *
 * Правила:
 *   • нет смен через полночь — консультации дневные;
 *   • шаг сетки = длительность слота (11:00, 11:45, 12:30…): запись только в дискретные слоты;
 *   • у слота есть вместимость: второй клиент на слот — резерв.
 */

import type { ConsultHours, ScheduleException, ScheduleWindow, TimeRange } from './types';
import { isoWeekday, minToTime, timeToMin } from './time';

/** Рабочие окна дня в минутах от начала суток; пусто — день нерабочий. */
export interface DayPlan {
  working: boolean;
  windows: [number, number][];
}

const OFF: DayPlan = { working: false, windows: [] };

/** Сортирует окна и склеивает пересекающиеся/смежные; пустые и обратные отбрасывает. */
export function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function toPlan(windows: readonly [number, number][]): DayPlan {
  const merged = mergeRanges(windows);
  return merged.length === 0 ? OFF : { working: true, windows: merged };
}

const rangeOf = (r: TimeRange): [number, number] => [timeToMin(r.start), timeToMin(r.end)];

/** План дня консультанта с графиком: исключение на дату → недельные окна → выходной. */
export function effectiveDay(
  date: string,
  schedule: readonly ScheduleWindow[],
  exceptions: readonly ScheduleException[],
): DayPlan {
  const exception = exceptions.find((e) => e.day === date);
  if (exception) {
    if (exception.kind === 'off') return OFF;
    return toPlan(exception.windows.map(rangeOf));
  }
  const wd = isoWeekday(date);
  return toPlan(schedule.filter((w) => w.weekday === wd).map(rangeOf));
}

/**
 * План дня консультанта БЕЗ графика — часы `booking.consult.hours`.
 * `isWorkday` — внедряемый рабочий календарь: праздник гасит день и здесь.
 */
export function defaultHoursDay(date: string, hours: ConsultHours, isWorkday?: (date: string) => boolean): DayPlan {
  if (!hours.workdays.includes(isoWeekday(date))) return OFF;
  if (isWorkday && !isWorkday(date)) return OFF;
  return toPlan([[timeToMin(hours.start), timeToMin(hours.end)]]);
}

/** Рабочие окна дня (план уже нормализован: без пересечений и пустых). */
export function workWindows(plan: DayPlan): [number, number][] {
  return plan.working ? plan.windows.map(([s, e]) => [s, e]) : [];
}

/** Старты слотов: каждое окно режется встык от своего начала. */
export function slotStarts(plan: DayPlan, slotMin: number): number[] {
  if (slotMin <= 0) return [];
  const out: number[] = [];
  for (const [ws, we] of workWindows(plan)) {
    for (let t = ws; t + slotMin <= we; t += slotMin) out.push(t);
  }
  return out;
}

/** Занятость: интервал записи в минутах суток. */
export interface Occupied {
  startTime: string;
  durationMin: number;
}

export function countOverlapping(start: number, durationMin: number, occupied: readonly Occupied[]): number {
  const end = start + durationMin;
  return occupied.filter((o) => {
    const os = timeToMin(o.startTime);
    return start < os + o.durationMin && end > os;
  }).length;
}

export interface SlotView {
  time: string;
  endTime: string;
  capacity: number;
  /** Сколько занимающих место записей пересекается со слотом. */
  taken: number;
  free: number;
  /** Следующая запись на этот слот пойдёт резервом. */
  nextIsReserve: boolean;
}

/** Слоты дня с занятостью и остатком вместимости. */
export function buildSlots(plan: DayPlan, slotMin: number, capacity: number, occupied: readonly Occupied[]): SlotView[] {
  return slotStarts(plan, slotMin).map((t) => {
    const taken = countOverlapping(t, slotMin, occupied);
    const free = Math.max(0, capacity - taken);
    return { time: minToTime(t), endTime: minToTime(t + slotMin), capacity, taken, free, nextIsReserve: free > 0 && taken > 0 };
  });
}

/** Влезает ли [start, start+dur) в одно из рабочих окон дня целиком. */
export function fitsPlan(plan: DayPlan, start: number, durationMin: number): boolean {
  const end = start + durationMin;
  return workWindows(plan).some(([ws, we]) => start >= ws && end <= we);
}

/**
 * Интервалы «свободен с … до …» на один день → окна исключения `custom`:
 * пересекающиеся и смежные сливаются, пустой список — null («не принимает»).
 * Это форма, в которую ложится ручной ввод (позже — разбор сообщения консультанта).
 */
export function intervalsToWindows(intervals: readonly TimeRange[]): TimeRange[] | null {
  const merged = mergeRanges(intervals.map(rangeOf));
  if (merged.length === 0) return null;
  return merged.map(([s, e]) => ({ start: minToTime(s), end: minToTime(e) }));
}
