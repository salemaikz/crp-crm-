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
 * Модуль чистый: Date.now() не вызывается, время приходит параметром.
 */

export type Tz = string;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: Tz): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Известен ли пояс рантайму (для проверки настроек). */
export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Смещение пояса от UTC в миллисекундах в данный момент (восточнее UTC — положительное). */
export function tzOffsetMs(tz: Tz, instantMs: number): number {
  const base = Math.floor(instantMs / 1000) * 1000;
  const get: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(base))) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(get.year ?? 1970, (get.month ?? 1) - 1, get.day ?? 1, (get.hour ?? 0) % 24, get.minute ?? 0, get.second ?? 0);
  return asUtc - base;
}

/** 'YYYY-MM-DD', существующая дата (30 февраля — нет). */
export function isLocalDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100) return false;
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
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
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function parts(date: string): [number, number, number] {
  if (!isLocalDate(date)) throw new RangeError(`[booking] ожидалась дата YYYY-MM-DD: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 0, m ?? 0, d ?? 0];
}

/** Момент (epoch ms) для местных даты и времени в поясе `tz`. */
export function localToEpoch(tz: Tz, date: string, time: string): number {
  const [y, m, d] = parts(date);
  const wall = Date.UTC(y, m - 1, d) + timeToMin(time) * 60_000;
  // Два шага: смещение берётся в момент результата, а не «стенных» часов (важно у границы перехода).
  const first = wall - tzOffsetMs(tz, wall);
  return wall - tzOffsetMs(tz, first);
}

/** Местная дата момента. */
export function epochToLocalDate(tz: Tz, ms: number): string {
  const shifted = new Date(ms + tzOffsetMs(tz, ms));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Местное время 'HH:MM' момента. */
export function epochToLocalTime(tz: Tz, ms: number): string {
  const shifted = new Date(ms + tzOffsetMs(tz, ms));
  return minToTime(shifted.getUTCHours() * 60 + shifted.getUTCMinutes());
}

/** Начало местных суток даты (epoch ms). */
export function localDayStart(tz: Tz, date: string): number {
  return localToEpoch(tz, date, '00:00');
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const next = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** ISO-день недели 1..7 (Пн..Вс). */
export function isoWeekday(date: string): number {
  const [y, m, d] = parts(date);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
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
