// Праздники и переносы (`calendar.holidays`): проверка строк и слияние слоёв по `date` как по ключу
// (CONFIG §3.1: корпоративный выходной клиента переживает обновление праздников слоя `kz`).
// Сами даты — данные пресета (`presets/kz`), а не код (D-061).
import type { CalendarHoliday, HolidayKind } from './types';
import { parseDay } from './zone';

const KINDS: readonly HolidayKind[] = ['holiday', 'workday'];

/** Проверяет строку и возвращает её копию; плохая дата или вид — RangeError. */
export function validateHoliday(row: CalendarHoliday): CalendarHoliday {
  parseDay(row.date);
  if (!KINDS.includes(row.kind)) throw new RangeError(`Вид строки календаря должен быть holiday или workday: ${String(row.kind)} (${row.date})`);
  if (row.note !== undefined && typeof row.note !== 'string') throw new RangeError(`Примечание должно быть строкой (${row.date})`);
  return row.note === undefined ? { date: row.date, kind: row.kind } : { date: row.date, kind: row.kind, note: row.note };
}

/**
 * Слияние слоёв по `date`: строка более позднего слоя перекрывает строку раннего целиком
 * (вид и примечание), остальные даты сохраняются. Результат отсортирован по дате.
 * Повторы внутри одного слоя тоже разрешаются «последний выигрывает».
 */
export function mergeHolidays(...layers: ReadonlyArray<readonly CalendarHoliday[]>): CalendarHoliday[] {
  const byDate = new Map<string, CalendarHoliday>();
  for (const layer of layers) for (const row of layer) byDate.set(row.date, validateHoliday(row));
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
