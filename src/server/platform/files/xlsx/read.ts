// Книга XLSX → сетка выбранного листа (дизайн C4d §3.3–3.4). Читаются только нужные части архива.
import { inflateEntry, newBudget, readZipDirectory } from '../zip';
import { SpreadsheetError, type SpreadsheetLimits, type SpreadsheetStats } from '../types';
import { parseSharedStrings } from './sharedStrings';
import { parseSheet } from './sheet';
import { parseStyles } from './styles';
import { parseRels, parseWorkbook, resolveSheetPath } from './workbook';

export function listSheets(buf: Uint8Array, limits: SpreadsheetLimits): string[] {
  const entries = readZipDirectory(buf, limits);
  const wb = entries.find((e) => e.name === 'xl/workbook.xml');
  if (!wb) throw new SpreadsheetError('corrupt');
  return parseWorkbook(inflateEntry(buf, wb, limits.zipSmallPartMaxBytes, newBudget(limits.zipTotalInflatedMaxBytes))).sheets.map((s) => s.name);
}

export function readXlsx(
  buf: Uint8Array,
  sheet: string | number | undefined,
  limits: SpreadsheetLimits,
): { sheets: string[]; sheetIndex: number; grid: string[][]; stats: SpreadsheetStats } {
  const entries = readZipDirectory(buf, limits);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const budget = newBudget(limits.zipTotalInflatedMaxBytes);
  const part = (name: string, max: number): Uint8Array | null => {
    const e = byName.get(name);
    return e ? inflateEntry(buf, e, max, budget) : null;
  };
  const wbXml = part('xl/workbook.xml', limits.zipSmallPartMaxBytes);
  const relsXml = part('xl/_rels/workbook.xml.rels', limits.zipSmallPartMaxBytes);
  if (!wbXml || !relsXml) throw new SpreadsheetError('corrupt');
  const wb = parseWorkbook(wbXml);
  const names = wb.sheets.map((s) => s.name);
  if (names.length === 0) throw new SpreadsheetError('corrupt');

  let index = -1;
  if (sheet === undefined) {
    if (names.length > 1) throw new SpreadsheetError('sheet_required', names);
    index = 0;
  } else if (typeof sheet === 'number') {
    index = Number.isInteger(sheet) && sheet >= 0 && sheet < names.length ? sheet : -1;
  } else {
    index = names.indexOf(sheet);
    if (index < 0 && /^\d+$/.test(sheet) && Number(sheet) < names.length) index = Number(sheet);
  }
  if (index < 0) throw new SpreadsheetError('sheet_not_found', names);

  const target = parseRels(relsXml).get((wb.sheets[index] as { rid: string }).rid);
  if (target === undefined) throw new SpreadsheetError('corrupt');
  const sheetXml = part(resolveSheetPath(target), limits.zipSheetMaxBytes);
  if (!sheetXml) throw new SpreadsheetError('corrupt');
  const sst = part('xl/sharedStrings.xml', limits.zipSharedStringsMaxBytes);
  const styles = part('xl/styles.xml', limits.zipStylesMaxBytes);
  const parsed = parseSheet(sheetXml, {
    shared: sst ? parseSharedStrings(sst, limits.sharedStringsMaxCount) : [],
    dateStyles: styles ? parseStyles(styles) : [],
    date1904: wb.date1904,
    limits,
  });
  return { sheets: names, sheetIndex: index, grid: parsed.grid, stats: parsed.stats };
}
