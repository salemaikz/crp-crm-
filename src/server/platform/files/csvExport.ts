// Выгрузка CSV для Excel русской локали (дизайн C4d §3.6): защита от формул на выходе.
import type { CsvCellValue } from './types';

/** Начало строки, которое Excel исполнит как формулу (после пробелов тоже), и ведущие TAB/CR. */
const FORMULA = /^(\s*[=+\-@]|[\t\r])/;

/**
 * Ячейка CSV: строка, похожая на формулу, получает ведущий апостроф; «;», кавычка и перевод строки
 * берут ячейку в кавычки с удвоением. Числа — как есть.
 */
export function csvCell(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Сетка → CSV: BOM UTF-8, разделитель «;», CRLF. */
export function toExcelCsv(grid: readonly (readonly CsvCellValue[])[]): string {
  return '﻿' + grid.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
