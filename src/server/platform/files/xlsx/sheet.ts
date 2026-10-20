// Лист XLSX → сетка строк (дизайн C4d §3.4). Формулы не читаются и не вычисляются: берётся только
// сохранённое значение. Пропущенные строки заполняются пустыми, чтобы не сдвинуть «диапазон строк → оператор».
import { SpreadsheetError, type SpreadsheetLimits, type SpreadsheetStats } from '../types';
import { serialToText } from './dates';
import { attr, parseXml } from './xml';

export interface SheetContext {
  shared: readonly string[];
  /** Индекс стиля → дата. */
  dateStyles: readonly boolean[];
  date1904: boolean;
  limits: Pick<SpreadsheetLimits, 'maxRows' | 'maxCols' | 'maxCellChars'>;
}

/** Колонка из ссылки `AB12` → индекс с 0; null, если ссылки нет или она неверна. */
export function columnIndex(ref: string | undefined): number | null {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(ref ?? '');
  if (!m) return null;
  let n = 0;
  for (const ch of (m[1] as string).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Управляющие символы, кроме \n и \t, удаляются. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000D-\u001F\u007F]/g;
export const cleanCell = (s: string): string => s.replace(CONTROL, '');

export function parseSheet(xml: Uint8Array, ctx: SheetContext): { grid: string[][]; stats: Omit<SpreadsheetStats, 'rows'> & { rows: number } } {
  const grid: string[][] = [];
  const stats = { rows: 0, truncatedCells: 0, droppedColumns: 0, formulaWithoutValue: 0, errorCells: 0 };
  const dropped = new Set<number>();
  let rowNo = 0;
  let row: string[] | null = null;
  let col = -1;
  // состояние ячейки
  let cellType = '';
  let cellStyle = -1;
  let value = '';
  let inlineText = '';
  let hasFormula = false;
  let inCell = false;
  let inV = false;
  let inIs = false;
  let inT = false;
  let phonetic = 0;

  const finishCell = () => {
    if (!row) return;
    let out: string;
    switch (cellType) {
      case 's': {
        const idx = Number(value);
        out = Number.isInteger(idx) && idx >= 0 && idx < ctx.shared.length ? (ctx.shared[idx] as string) : '';
        break;
      }
      case 'inlineStr':
        out = inlineText;
        break;
      case 'b':
        out = value === '1' || value === 'true' ? '1' : value === '' ? '' : '0';
        break;
      case 'e':
        out = '';
        if (value !== '') stats.errorCells++;
        break;
      case 'str':
      case 'd':
        out = value;
        break;
      default: {
        // число (t="n" или без t): текст как есть, чтобы 77091234567 не стало 7.7e10; дата — по формату стиля
        const v = value.trim();
        out = v;
        if (v !== '' && cellStyle >= 0 && ctx.dateStyles[cellStyle]) out = serialToText(v, ctx.date1904) ?? v;
      }
    }
    if (hasFormula && value === '' && inlineText === '') stats.formulaWithoutValue++;
    if (out === '') return;
    out = cleanCell(out);
    if (out.length > ctx.limits.maxCellChars) {
      out = out.slice(0, ctx.limits.maxCellChars);
      stats.truncatedCells++;
    }
    if (col >= ctx.limits.maxCols) {
      dropped.add(col);
      return;
    }
    while (row.length < col) row.push('');
    row[col] = out;
  };

  parseXml(xml, {
    open(local, a, selfClosing) {
      if (local === 'row') {
        const r = Number(attr(a, 'r'));
        const next = Number.isInteger(r) && r >= 1 ? r : rowNo + 1;
        if (next > ctx.limits.maxRows) throw new SpreadsheetError('too_many_rows');
        if (next <= rowNo) throw new SpreadsheetError('corrupt');
        while (grid.length < next - 1) grid.push([]);
        row = [];
        grid.push(row);
        rowNo = next;
        col = -1;
        if (selfClosing) row = null;
      } else if (local === 'c' && row) {
        const c = columnIndex(attr(a, 'r'));
        col = c ?? col + 1;
        cellType = attr(a, 't') ?? '';
        const s = Number(attr(a, 's'));
        cellStyle = Number.isInteger(s) ? s : -1;
        value = '';
        inlineText = '';
        hasFormula = false;
        inCell = true;
        if (selfClosing) {
          inCell = false;
        }
      } else if (inCell) {
        if (local === 'v') inV = true;
        else if (local === 'f') hasFormula = true;
        else if (local === 'is') inIs = true;
        else if (local === 'rPh') phonetic++;
        else if (local === 't' && inIs && phonetic === 0) inT = true;
      }
    },
    text(t) {
      if (inV) value += t;
      else if (inT) inlineText += t;
    },
    close(local) {
      if (local === 'row') row = null;
      else if (local === 'c' && inCell) {
        finishCell();
        inCell = false;
        inV = inIs = inT = false;
        phonetic = 0;
      } else if (local === 'v') inV = false;
      else if (local === 'is') inIs = false;
      else if (local === 't') inT = false;
      else if (local === 'rPh') phonetic--;
    },
  });
  stats.rows = grid.length;
  stats.droppedColumns = dropped.size;
  return { grid, stats };
}
