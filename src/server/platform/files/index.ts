// Чтение загруженных таблиц для импорта (дизайн C4d, docs/import-design.md §3, D-111, D-112).
// Файл на диск не пишется и не хранится: всё читается из буфера в памяти; архив XLSX не
// распаковывается целиком — только нужные части и с жёстким пределом на выход inflate.
// Next здесь не импортируется: Request — веб-стандарт.
import { createHash } from 'node:crypto';
import { parseCsvGrid } from './csv';
import { sniffSpreadsheet } from './sniff';
import { FILE_LIMITS, SpreadsheetError, type ReadSpreadsheetOptions, type Sniffed, type SpreadsheetLimits, type SpreadsheetResult } from './types';
import { listSheets, readXlsx } from './xlsx/read';

export * from './types';
export { readBodyLimited } from './body';
export { csvCell, toExcelCsv } from './csvExport';

/** Пределы одного чтения из жёстких пределов кода и настроек установки (их только сужают). */
export function limitsFor(s: { maxFileMb: number; maxRows: number }): SpreadsheetLimits {
  return {
    maxBytes: Math.min(s.maxFileMb * 1024 * 1024, FILE_LIMITS.maxBytesHard),
    maxRows: s.maxRows + FILE_LIMITS.rowsSlack,
    maxCols: FILE_LIMITS.maxCols,
    maxCellChars: FILE_LIMITS.maxCellChars,
    zipMaxEntries: FILE_LIMITS.zipMaxEntries,
    zipMaxCentralDirBytes: FILE_LIMITS.zipMaxCentralDirBytes,
    zipSmallPartMaxBytes: FILE_LIMITS.zipSmallPartMaxBytes,
    zipStylesMaxBytes: FILE_LIMITS.zipStylesMaxBytes,
    zipSharedStringsMaxBytes: FILE_LIMITS.zipSharedStringsMaxBytes,
    zipSheetMaxBytes: FILE_LIMITS.zipSheetMaxBytes,
    zipTotalInflatedMaxBytes: FILE_LIMITS.zipTotalInflatedMaxBytes,
    sharedStringsMaxCount: FILE_LIMITS.sharedStringsMaxCount,
  };
}

/** Тип по сигнатуре (PK → xlsx, OLE2 → legacy_xls, PDF/картинки/NUL → bad_type, иначе CSV). */
export function sniff(buf: Uint8Array, limits: SpreadsheetLimits): Sniffed {
  return sniffSpreadsheet(buf, limits);
}
export { sniffSpreadsheet };

/** Имена листов книги в порядке workbook.xml. */
export function listXlsxSheets(buf: Uint8Array, limits: SpreadsheetLimits): string[] {
  return listSheets(buf, limits);
}

let active = 0;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Файл → сетка строк. Порядок: семафор разборов (занято → 'busy') → предел размера → сигнатура →
 * CSV: декодирование и разбор ядра; XLSX: workbook, rels, выбранный лист, sharedStrings, styles →
 * пределы строк, колонок и длины ячейки → sha256. Бросает SpreadsheetError; другие ошибки — баг.
 */
export async function readSpreadsheet(buf: Uint8Array, opts: ReadSpreadsheetOptions): Promise<SpreadsheetResult> {
  if (active >= FILE_LIMITS.concurrentParses) throw new SpreadsheetError('busy');
  active++;
  try {
    // уступаем цикл событий: параллельный вызов увидит занятый семафор, а не дождётся конца синхронного разбора
    await yieldLoop();
    const { limits } = opts;
    if (buf.length === 0) throw new SpreadsheetError('empty');
    if (buf.length > limits.maxBytes) throw new SpreadsheetError('too_large');
    const kind = sniffSpreadsheet(buf, limits);
    if (!kind.ok) throw new SpreadsheetError(kind.code);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    if (kind.kind === 'csv') {
      const { grid, stats } = parseCsvGrid(buf, kind.encoding, limits);
      return { kind: 'csv', encoding: kind.encoding, sheets: [], sheetIndex: 0, grid, stats, sha256 };
    }
    const x = readXlsx(buf, opts.sheet, limits);
    return { kind: 'xlsx', encoding: null, sheets: x.sheets, sheetIndex: x.sheetIndex, grid: x.grid, stats: x.stats, sha256 };
  } finally {
    active--;
  }
}
