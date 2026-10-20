/**
 * CSV для выгрузок записи.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/csv.ts.
 *
 * BOM в начале и CRLF: без BOM Excel на Windows читает кириллицу как кракозябры.
 *
 * ЗАЩИТА ОТ ФОРМУЛ. Имя клиента и примечание набирает оператор, а файл открывают в Excel.
 * Ячейка «=HYPERLINK(…)» выполнится как формула, поэтому такие значения экранируем апострофом.
 * Телефон «+7 709 …» начинается с плюса, но формулой не является — его не трогаем.
 */

export type CsvCell = string | number | null | undefined;

const PHONE_LIKE = /^[+-][\d\s()-]*$/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !PHONE_LIKE.test(s))) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: readonly (readonly CsvCell[])[]): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
