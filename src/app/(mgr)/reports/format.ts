// Форматирование чисел отчётов (ru-RU).
const NUM = new Intl.NumberFormat('ru-RU');
const DEC = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => NUM.format(n);
export const fmtDec = (n: number): string => DEC.format(n);

/** `2026-10-28` → `28.10.2026`. */
export function formatDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
}
