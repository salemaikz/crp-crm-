// Арифметика местных дней 'YYYY-MM-DD' на клиенте: быстрый выбор периода. Пояса нет — это календарь; «сегодня»
// приходит с сервера (в поясе установки).
const MS_DAY = 86_400_000;

const ms = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const fmt = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return fmt(ms(day) + n * MS_DAY);
}

/** 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(day: string): number {
  const d = new Date(ms(day)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function mondayOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / MS_DAY) + 1;
}

export function lastDayOfMonth(day: string): string {
  const d = new Date(ms(day));
  return fmt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

export type Preset = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth';
export const PRESETS: readonly Preset[] = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'];

export function presetRange(preset: Preset, today: string): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'thisWeek':
      return { from: mondayOf(today), to: today };
    case 'lastWeek': {
      const monday = mondayOf(today);
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    }
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const first = `${today.slice(0, 7)}-01`;
      const prevLast = addDays(first, -1);
      return { from: `${prevLast.slice(0, 7)}-01`, to: prevLast };
    }
  }
}

/** Проверка периода на клиенте (сервер проверяет то же): from ≤ to, до 92 дней, to не позже завтра. */
export function periodProblem(from: string, to: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return true;
  return from > to || daysBetween(from, to) > 92 || to > addDays(today, 1);
}
