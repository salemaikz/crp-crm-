// Рабочий календарь установки: рабочие дни, праздники и переносы, рабочие часы и окно звонков
// (CONFIG §6.1–6.2, PROCESS §3.4 и §7.2). Всё приходит параметрами из настроек; `Date.now()` не вызывается,
// «сейчас» передаёт вызывающий. Окна полуоткрытые: начало входит, конец уже вне окна.
// Контракт `WorkCalendar` из `calling/spec/types.ts` выполняется структурно (проверяет тест).
import { mergeHolidays } from './holidays';
import type { CalendarSettings, DayInfo, HHMM, HoursWindow, LocalDay, Ms, WindowKind } from './types';
import { addCalendarDays, addLocalDays, assertTimeZone, fromLocalMsOfDay, isoWeekday, localDayOf, parseDay, parseHHMM, toLocalTime } from './zone';

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
/** Предел поиска рабочего дня вперёд: ~10 лет. Дальше — ошибка настройки (нет рабочих дней). */
const MAX_SCAN_DAYS = 3660;

export interface WorkCalendar {
  readonly timezone: string;
  /** Начало окна звонков, 'HH:MM' (`calendar.callWindow.start`). */
  readonly callWindowStart: HHMM;

  // --- Сутки ---
  /** Местные сутки момента. */
  localDay(at: Ms): LocalDay;
  /** Рабочий ли день: рабочие дни недели, минус праздники и выходные переносы, плюс рабочие переносы. */
  isWorkday(day: LocalDay): boolean;
  /** Почему день рабочий или нет (для экранов и отчётов). */
  dayInfo(day: LocalDay): DayInfo;
  /** Первый рабочий день строго после `day`. */
  nextWorkday(day: LocalDay): LocalDay;
  /** `day`, если он рабочий, иначе ближайший рабочий после него. */
  workdayOnOrAfter(day: LocalDay): LocalDay;
  /** Сдвиг на `n` ≥ 1 рабочих дней вперёд от `day` (сам `day` не считается). */
  addWorkdays(day: LocalDay, n: number): LocalDay;

  // --- Окна ---
  /** Момент в рабочих часах рабочего дня (`calendar.workHours`). */
  isWorkingMoment(at: Ms): boolean;
  /** Ближайший рабочий момент не раньше `at`: сам `at`, если он рабочий, иначе начало ближайшего рабочего окна. */
  nextWorkingMoment(at: Ms): Ms;
  /** Момент в окне звонков рабочего дня (`calendar.callWindow`). */
  isInCallWindow(at: Ms): boolean;
  /** Ближайший момент окна звонков не раньше `at`. */
  nextCallMoment(at: Ms): Ms;

  // --- Сдвиги ---
  /** `hhmm` первого рабочего дня строго после местных суток `at` (шаг `nextWorkday@HH:MM`). */
  nextWorkdayAt(at: Ms, hhmm: HHMM): Ms;
  /** `hhmm` n-го (n ≥ 1) рабочего дня строго после местных суток `at`. */
  nthWorkdayAt(at: Ms, n: number, hhmm: HHMM): Ms;
  /** Первый момент с местным временем `hhmm` в рабочий день, строго позже `after`. */
  nextWorkdayTimeAfter(after: Ms, hhmm: HHMM): Ms;
  /** Плюс `days` календарных суток в местном поясе, то же местное время. */
  addDays(at: Ms, days: number): Ms;
  /**
   * Правило повтора «+N, а если не попало в окно — ближайшие HH:MM рабочего дня»: `at + deltaMs`, если момент в окне
   * (по умолчанию звонков), иначе `nextWorkdayTimeAfter(at + deltaMs, hhmm)`. `hhmm` должно лежать внутри окна.
   */
  addInWindowOrNextAt(at: Ms, deltaMs: Ms, hhmm: HHMM, window?: WindowKind): Ms;

  // --- Рабочие часы ---
  /**
   * Плюс `ms` мс рабочего времени: считаются только рабочие часы рабочих дней, выходные и праздники пропускаются.
   * Начало вне рабочих часов переносится на ближайший рабочий момент. Если время набралось ровно к концу окна,
   * вернётся конец окна (18:00), а не начало следующего дня. Для `ms = 0` вернёт `at`.
   */
  addWorkingMs(at: Ms, ms: number): Ms;
  addWorkingHours(at: Ms, hours: number): Ms;
  /** Сколько мс рабочего времени между `from` и `to` (to ≥ from). Обратно к `addWorkingMs`. */
  workingMsBetween(from: Ms, to: Ms): Ms;
}

interface Bounds {
  readonly startMin: number;
  readonly endMin: number;
}

function windowBounds(w: HoursWindow, what: string): Bounds {
  const startMin = parseHHMM(w.start);
  const endMin = parseHHMM(w.end);
  if (startMin >= endMin) throw new RangeError(`${what}: начало (${w.start}) должно быть раньше конца (${w.end})`);
  return { startMin, endMin };
}

export function createWorkCalendar(settings: CalendarSettings): WorkCalendar {
  const tz = settings.timezone;
  assertTimeZone(tz);

  const workdays = new Set<number>();
  for (const d of settings.workdays) {
    if (!Number.isInteger(d) || d < 1 || d > 7) throw new RangeError(`calendar.workdays: день недели 1–7 (ISO), получено ${String(d)}`);
    workdays.add(d);
  }
  if (workdays.size === 0) throw new RangeError('calendar.workdays: нужен хотя бы один рабочий день');

  const bounds: Record<WindowKind, Bounds> = {
    work: windowBounds(settings.workHours, 'calendar.workHours'),
    call: windowBounds(settings.callWindow, 'calendar.callWindow'),
  };

  const overrides = new Map(mergeHolidays(settings.holidays).map((h) => [h.date, h] as const));

  const isWorkday = (day: LocalDay): boolean => {
    const o = overrides.get(parseDayKey(day));
    if (o) return o.kind === 'workday';
    return workdays.has(isoWeekday(day));
  };

  const nextWorkday = (day: LocalDay): LocalDay => {
    let d = day;
    for (let i = 0; i < MAX_SCAN_DAYS; i++) {
      d = addLocalDays(d, 1);
      if (isWorkday(d)) return d;
    }
    throw new RangeError('Нет рабочих дней в ближайшие 10 лет: проверьте calendar.workdays и calendar.holidays');
  };

  const nthWorkday = (day: LocalDay, n: number): LocalDay => {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`Число рабочих дней должно быть целым и не меньше 1: ${n}`);
    let d = day;
    for (let i = 0; i < n; i++) d = nextWorkday(d);
    return d;
  };

  const localDay = (at: Ms): LocalDay => localDayOf(at, tz);

  /** Границы окна на дату `day`: [начало, конец) в epoch-мс. */
  const span = (day: LocalDay, kind: WindowKind): [Ms, Ms] => {
    const b = bounds[kind];
    return [fromLocalMsOfDay(day, b.startMin * MS_MINUTE, tz), fromLocalMsOfDay(day, b.endMin * MS_MINUTE, tz)];
  };

  const isInWindow = (at: Ms, kind: WindowKind): boolean => {
    const p = toLocalTime(at, tz);
    if (!isWorkday(p.day)) return false;
    const b = bounds[kind];
    return p.msOfDay >= b.startMin * MS_MINUTE && p.msOfDay < b.endMin * MS_MINUTE;
  };

  const nextInWindow = (at: Ms, kind: WindowKind): Ms => {
    const day = localDay(at);
    if (isWorkday(day)) {
      const [s, e] = span(day, kind);
      if (at < s) return s;
      if (at < e) return at;
    }
    return span(nextWorkday(day), kind)[0];
  };

  const nextWorkdayTimeAfter = (after: Ms, hhmm: HHMM): Ms => {
    const msOfDay = parseHHMM(hhmm) * MS_MINUTE;
    let d = localDay(after);
    for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
      if (isWorkday(d)) {
        const c = fromLocalMsOfDay(d, msOfDay, tz);
        if (c > after) return c;
      }
      d = addLocalDays(d, 1);
    }
    throw new RangeError('Нет рабочих дней в ближайшие 10 лет: проверьте calendar.workdays и calendar.holidays');
  };

  const addWorkingMs = (at: Ms, ms: number): Ms => {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Рабочее время должно быть неотрицательным числом мс: ${ms}`);
    if (ms === 0) return at;
    let cur = nextInWindow(at, 'work');
    let rest = ms;
    for (;;) {
      const day = localDay(cur);
      const end = span(day, 'work')[1];
      const room = end - cur;
      if (rest <= room) return cur + rest;
      rest -= room;
      cur = span(nextWorkday(day), 'work')[0];
    }
  };

  const workingMsBetween = (from: Ms, to: Ms): Ms => {
    if (to < from) throw new RangeError('workingMsBetween: конец раньше начала');
    const lastDay = localDay(to);
    let total = 0;
    for (let d = localDay(from); d <= lastDay; d = addLocalDays(d, 1)) {
      if (!isWorkday(d)) continue;
      const [s, e] = span(d, 'work');
      const lo = Math.max(s, from);
      const hi = Math.min(e, to);
      if (hi > lo) total += hi - lo;
    }
    return total;
  };

  return {
    timezone: tz,
    callWindowStart: settings.callWindow.start,
    localDay,
    isWorkday,
    dayInfo(day) {
      const key = parseDayKey(day);
      const o = overrides.get(key);
      const base = o?.note === undefined ? { day: key } : { day: key, note: o.note };
      if (o) {
        if (o.kind === 'holiday') return { ...base, workday: false, reason: 'holiday' };
        const regular = workdays.has(isoWeekday(key));
        return { ...base, workday: true, reason: regular ? 'workday' : 'transferred_workday' };
      }
      return workdays.has(isoWeekday(key)) ? { ...base, workday: true, reason: 'workday' } : { ...base, workday: false, reason: 'weekend' };
    },
    nextWorkday,
    workdayOnOrAfter: (day) => (isWorkday(day) ? day : nextWorkday(day)),
    addWorkdays: nthWorkday,
    isWorkingMoment: (at) => isInWindow(at, 'work'),
    nextWorkingMoment: (at) => nextInWindow(at, 'work'),
    isInCallWindow: (at) => isInWindow(at, 'call'),
    nextCallMoment: (at) => nextInWindow(at, 'call'),
    nextWorkdayAt: (at, hhmm) => fromLocalMsOfDay(nthWorkday(localDay(at), 1), parseHHMM(hhmm) * MS_MINUTE, tz),
    nthWorkdayAt: (at, n, hhmm) => fromLocalMsOfDay(nthWorkday(localDay(at), n), parseHHMM(hhmm) * MS_MINUTE, tz),
    nextWorkdayTimeAfter,
    addDays: (at, days) => addCalendarDays(at, days, tz),
    addInWindowOrNextAt(at, deltaMs, hhmm, window = 'call') {
      const t = at + deltaMs;
      return isInWindow(t, window) ? t : nextWorkdayTimeAfter(t, hhmm);
    },
    addWorkingMs,
    addWorkingHours: (at, hours) => addWorkingMs(at, Math.round(hours * MS_HOUR)),
    workingMsBetween,
  };
}

/** Проверяет формат суток (бросает RangeError) и возвращает их же: ключ для таблицы переносов. */
function parseDayKey(day: LocalDay): LocalDay {
  parseDay(day);
  return day;
}
