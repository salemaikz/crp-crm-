// Даты и время мастера. Дата и время приходят местными строками пояса организации (YYYY-MM-DD, HH:MM),
// поэтому форматируется календарная дата без пересчёта в пояс телефона. Язык Intl — `ru` или `kk` (D-002).

function utcNoon(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12));
}

const fmt = (locale: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...o, timeZone: 'UTC' });

/** «чт, 29 окт.» */
export function formatDay(date: string, locale: string): string {
  return fmt(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(utcNoon(date));
}

/** «чт, 29 окт., 15:00» */
export function formatWhen(date: string, time: string, locale: string): string {
  return `${formatDay(date, locale)}, ${time}`;
}

/** Подпись чипа дня: «чт 29». */
export function formatChipDay(date: string, locale: string): string {
  const parts = fmt(locale, { weekday: 'short', day: 'numeric' }).formatToParts(utcNoon(date));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')}`;
}
