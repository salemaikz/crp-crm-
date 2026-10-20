// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (parseCsvRecords), переписан по ревью ядра.
// Разбор CSV в массив строк. Переводы строк ВНУТРИ кавычек остаются в ячейке: в заметках они есть,
// построчный разбор сдвинул бы номера строк (а по ним задан владелец-диапазон).
//  - Разделитель определяется по строке заголовков (первая строка, где нашлись колонки профиля),
//    а не по первой строке файла: над заголовками часто стоит баннер с запятыми.
//  - Кавычка открывает кавычечную ячейку только в начале ячейки; в середине — обычный символ.
//  - Кавычка без пары (до конца файла, на слишком много строк или с текстом сразу после закрывающей)
//    не «съедает» файл: она считается обычным символом, строка получает ошибку, номера строк не едут.

import { normalizeLabel } from './answer';

export type CsvDelimiter = ';' | ',' | '\t';

export interface CsvOptions {
  /** Заголовки колонок профиля (`Object.keys(profile.columns)`): по ним ищется строка заголовков. */
  headers?: readonly string[];
  /** Сколько первых строк смотреть при поиске заголовков (по умолчанию 10, как `headerScanRows`). */
  scanRows?: number;
  /** Сколько переводов строк может быть внутри одной кавычечной ячейки (по умолчанию 30). */
  maxCellLines?: number;
}

export interface CsvRowError {
  /** Номер строки-записи (1 — первая), тот же, что `rowNo` разбора таблицы. */
  rowNo: number;
  code: 'bad_quote';
}

export interface CsvResult {
  rows: string[][];
  delimiter: CsvDelimiter;
  errors: CsvRowError[];
}

const DELIMS: readonly CsvDelimiter[] = [';', ',', '\t'];

/** Ячейки физической строки при грубом разбиении (для выбора разделителя; кавычки по краям сняты). */
const roughCells = (line: string, d: string): string[] => line.split(d).map((c) => c.trim().replace(/^"|"$/g, ''));

export function detectDelimiter(src: string, opts: CsvOptions = {}): CsvDelimiter {
  const lines = src.split(/\r?\n|\r/, opts.scanRows ?? 10);
  const known = new Set((opts.headers ?? []).map(normalizeLabel).filter(Boolean));
  if (known.size > 0) {
    for (const line of lines) {
      let best: CsvDelimiter | null = null;
      let bestHits = 0;
      for (const d of DELIMS) {
        const hits = roughCells(line, d).filter((c) => known.has(normalizeLabel(c))).length;
        if (hits > bestHits) [best, bestHits] = [d, hits];
      }
      // Строка заголовков — где нашлись хотя бы две колонки профиля (одно слово бывает и в баннере).
      if (best && bestHits >= Math.min(2, known.size)) return best;
    }
  }
  // Без подсказки: разделитель, которого больше всего в одной строке (баннер короче заголовков).
  let best: CsvDelimiter = ',';
  let max = 0;
  for (const line of lines) {
    for (const d of DELIMS) {
      const n = line.split(d).length - 1;
      if (n > max) [best, max] = [d, n];
    }
  }
  return best;
}

export function parseCsv(text: string, opts: CsvOptions = {}): CsvResult {
  const src = text.replace(/^﻿/, '');
  const delim = detectDelimiter(src, opts);
  const maxLines = opts.maxCellLines ?? 30;
  const rows: string[][] = [];
  const errors: CsvRowError[] = [];
  /** Позиции кавычек, признанных «без пары»: при повторном проходе это обычный символ. */
  const literal = new Set<number>();

  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  /** Где открылась текущая кавычечная ячейка и сколько переводов строк в ней уже было. */
  let qStart = -1;
  let qLines = 0;

  /** Кавычка в `qStart` — без пары: откат к ней, дальше она обычный символ. Строки до неё уже готовы. */
  const rollback = (): number => {
    literal.add(qStart);
    cell = '';
    inQuotes = false;
    const rowNo = rows.length + 1;
    if (!errors.some((e) => e.rowNo === rowNo)) errors.push({ rowNo, code: 'bad_quote' });
    return qStart - 1; // цикл продолжит с самой кавычки
  };
  /** После закрывающей кавычки допустимы пробелы, затем разделитель, конец строки или файла. */
  const closesCell = (j: number): boolean => {
    while (src[j] === ' ' || (src[j] === '\t' && delim !== '\t')) j++;
    const c = src[j];
    return c === undefined || c === delim || c === '\n' || c === '\r';
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        if (closesCell(i + 1)) inQuotes = false;
        else i = rollback(); // «закрылась» чужой кавычкой из другой ячейки
      } else {
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) qLines++;
        if (qLines > maxLines) i = rollback();
        else cell += ch;
      }
      if (inQuotes && i === src.length - 1) i = rollback(); // файл кончился внутри кавычек
      continue;
    }
    if (ch === '"' && cell === '' && !literal.has(i)) {
      inQuotes = true;
      qStart = i;
      qLines = 0;
      if (i === src.length - 1) i = rollback();
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  errors.sort((a, b) => a.rowNo - b.rowNo);
  return { rows, delimiter: delim, errors };
}

/** Только строки (ошибки кавычек — в `parseCsv`). */
export function parseCsvRecords(text: string, opts: CsvOptions = {}): string[][] {
  return parseCsv(text, opts).rows;
}

/** Обратная операция: массив строк → CSV (UTF-8, CRLF). Нужна генератору фикстур; ячейки с `"`, разделителем и переводами строк квотируются. */
export function toCsv(grid: readonly (readonly string[])[], delimiter = ','): string {
  const q = (c: string) => (/["\r\n]/.test(c) || c.includes(delimiter) ? `"${c.replace(/"/g, '""')}"` : c);
  return grid.map((r) => r.map(q).join(delimiter)).join('\r\n') + '\r\n';
}
