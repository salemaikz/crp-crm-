// Источник: SalemAI 108fb70 src/lib/crm/coldImport.ts (parseCsvRecords).
// Разбор CSV в массив строк. Переводы строк ВНУТРИ кавычек остаются в ячейке: в заметках они есть,
// построчный разбор сдвинул бы номера строк (а по ним задан владелец-диапазон).

/** Разделитель определяется по первой строке: `;` или `,` (чего больше). */
export function parseCsvRecords(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
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
  return rows;
}

/** Обратная операция: массив строк → CSV (UTF-8, CRLF). Нужна генератору фикстур; ячейки с `"`, разделителем и переводами строк квотируются. */
export function toCsv(grid: readonly (readonly string[])[], delimiter = ','): string {
  const q = (c: string) => (/["\r\n]/.test(c) || c.includes(delimiter) ? `"${c.replace(/"/g, '""')}"` : c);
  return grid.map((r) => r.map(q).join(delimiter)).join('\r\n') + '\r\n';
}
