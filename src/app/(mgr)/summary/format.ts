// Форматирование сводки: время в поясе установки.
const LOCALE = 'ru-RU';

/** Часы и минуты в поясе установки: `14:05`. */
export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** Время связи: сегодня — часы и минуты, раньше — ещё и дата. */
export function formatSeen(ms: number, now: number, timeZone: string): string {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(t));
  if (day(ms) === day(now)) return formatTime(ms, timeZone);
  const date = new Intl.DateTimeFormat(LOCALE, { timeZone, day: '2-digit', month: '2-digit' }).format(new Date(ms));
  return `${date} ${formatTime(ms, timeZone)}`;
}

/** `2026-10-28` → `28.10.2026`. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}
