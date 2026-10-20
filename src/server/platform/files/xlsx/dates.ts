// Серийные даты Excel → текст 'YYYY-MM-DD' или 'YYYY-MM-DD HH:MM' (дизайн C4d §3.4). Арифметика в UTC.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** Число как в `<v>` → дата; не число или вне разумного диапазона — null (значение остаётся текстом). */
export function serialToText(raw: string, date1904: boolean): string | null {
  const serial = Number(raw);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const minutes = Math.round(serial * 1440);
  const d = new Date((date1904 ? EPOCH_1904 : EPOCH_1900) + minutes * MINUTE_MS);
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const minuteOfDay = (((minutes % 1440) + 1440) % 1440) | 0;
  if (minuteOfDay === 0) return day;
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export { DAY_MS };
