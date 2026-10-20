// CSV → сетка строк (дизайн C4d §3.5): декодирование по кодировке сигнатуры, разбор — функция ядра
// (переводы строк внутри кавычек остаются в ячейке), затем те же пределы, что у XLSX.
import { imports } from '@crm/core';
import { cleanCell } from './xlsx/sheet';
import { SpreadsheetError, type CsvEncoding, type SpreadsheetLimits, type SpreadsheetStats } from './types';

export function decodeCsv(buf: Uint8Array, encoding: CsvEncoding): string {
  // TextDecoder сам снимает BOM UTF-8
  return new TextDecoder(encoding).decode(buf);
}

export function parseCsvGrid(buf: Uint8Array, encoding: CsvEncoding, limits: Pick<SpreadsheetLimits, 'maxRows' | 'maxCols' | 'maxCellChars'>): { grid: string[][]; stats: SpreadsheetStats } {
  const rows = imports.parseCsvRecords(decodeCsv(buf, encoding));
  if (rows.length > limits.maxRows) throw new SpreadsheetError('too_many_rows');
  const stats: SpreadsheetStats = { rows: rows.length, truncatedCells: 0, droppedColumns: 0, formulaWithoutValue: 0, errorCells: 0 };
  let widest = 0;
  const grid = rows.map((r) => {
    widest = Math.max(widest, r.length);
    return r.slice(0, limits.maxCols).map((c) => {
      let v = cleanCell(c);
      if (v.length > limits.maxCellChars) {
        v = v.slice(0, limits.maxCellChars);
        stats.truncatedCells++;
      }
      return v;
    });
  });
  stats.droppedColumns = Math.max(0, widest - limits.maxCols);
  return { grid, stats };
}
