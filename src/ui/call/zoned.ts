// Местное время в поясе установки без библиотек: сутки, «завтра 10:00», рабочий день. Ядро (@crm/core) в браузер
// не попадает (D-101), поэтому на устройстве считается только то, что нужно шторке; сервер всё равно проверяет.

export type LocalDay = string;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    dtfCache.set(tz, f);
  }
  return f;
}

export interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

export function partsOf(ms: number, tz: string): Parts {
  const o: Record<string, number> = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year ?? 0, m: o.month ?? 0, d: o.day ?? 0, h: o.hour ?? 0, mi: o.minute ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Местные сутки момента: `2026-10-28`. */
export function localDay(ms: number, tz: string): LocalDay {
  const p = partsOf(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function utcOffset(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
}

/** Момент (мс) для местной даты и времени `HH:MM`. */
export function fromLocal(day: LocalDay, hhmm: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  let guess = asUtc - utcOffset(asUtc, tz);
  guess = asUtc - utcOffset(guess, tz);
  return guess;
}

export function addDays(day: LocalDay, n: number): LocalDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(day: LocalDay): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Значение для `<input type="datetime-local">` в поясе установки: `2026-10-28T11:00`. */
export function toInputValue(ms: number, tz: string): string {
  const p = partsOf(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** Обратное преобразование; мусор → null. */
export function fromInputValue(value: string, tz: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return m ? fromLocal(m[1] as string, m[2] as string, tz) : null;
}
