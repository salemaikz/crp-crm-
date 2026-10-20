// Выгрузка CSV для Excel русской локали (дизайн C4d §3.6, R3b §2.2): защита от формул на выходе.
import type { CsvCellValue } from './types';

/** Начало строки, которое Excel исполнит как формулу (после пробелов тоже), и ведущие TAB/CR. */
const FORMULA = /^(\s*[=+\-@]|[\t\r])/;

/** Строка, которую табличный редактор примет за формулу (то же правило, что у CSV; им пользуется и XLSX). */
export function looksLikeFormula(s: string): boolean {
  return FORMULA.test(s);
}

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

const encoder = new TextEncoder();

/**
 * Построчная выгрузка (полная выгрузка): те же правила, что у toExcelCsv, но строки приходят потоком и уходят
 * кусками байтов. Первым идёт BOM; строки копятся примерно до `chunkChars` символов, чтобы не дробить поток.
 */
export async function* toExcelCsvLines(rows: AsyncIterable<readonly CsvCellValue[]>, opts: { chunkChars?: number } = {}): AsyncGenerator<Uint8Array> {
  const limit = opts.chunkChars ?? 64 * 1024;
  let buf = '﻿';
  for await (const row of rows) {
    buf += row.map(csvCell).join(';') + '\r\n';
    if (buf.length >= limit) {
      yield encoder.encode(buf);
      buf = '';
    }
  }
  if (buf.length > 0) yield encoder.encode(buf);
}
