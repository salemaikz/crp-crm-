// Форматирование экрана раздачи: даты и время в поясе установки.
const LOCALE = 'ru-RU';

export function formatDateTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms))
    .replace(', ', ' ');
}

/** `2026-10-28` → `28.10.2026`. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}
