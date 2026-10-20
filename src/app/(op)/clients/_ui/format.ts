// Форматирование для карточки клиента: номер, даты в поясе установки, деньги, подписи настроек.
import type { Label } from './types';

const LOCALE = 'ru-RU';

/** `+77091234567` → `+7 709 123 45 67`; всё прочее — как есть. */
export function formatPhone(e164: string): string {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+7 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : e164;
}

/** Дата и время в поясе установки: `28.10.2026 11:00`. */
export function formatDateTime(ms: number, timeZone: string): string {
  const s = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
  return s.replace(', ', ' ');
}

/** `2026-10-28` → `28.10.2026`. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(n);
}

/** Подпись из настроек: казахская, если есть и интерфейс казахский, иначе русская. */
export function labelOf(label: Label, locale: string = 'ru'): string {
  return (locale === 'kk' && label.kk) || label.ru;
}
