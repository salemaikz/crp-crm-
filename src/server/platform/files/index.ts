// Чтение загруженных таблиц для импорта — СИГНАТУРЫ (дизайн C4d, docs/import-design.md §3, D-111, D-112).
// Тела пишет builder в задаче C4-files; сигнатуры и коды ошибок не меняет (правка — через architect).
// Раскладка реализации: body.ts, sniff.ts, zip.ts и ooxml.ts (перенос с переделкой под буфер:
// платформа LMS 2cd8a2b src/lib/storage/{zip,ooxml,sniff}.ts), xlsx/{workbook,sheet,styles,dates}.ts,
// csv.ts (декодирование), csvExport.ts (выгрузка). Next здесь не импортируется: Request — веб-стандарт.
import type { CsvCellValue, ReadSpreadsheetOptions, Sniffed, SpreadsheetLimits, SpreadsheetResult } from './types';

export * from './types';

const TODO = 'C4-files: не реализовано (docs/import-design.md §3)';

/**
 * Тело запроса целиком в память, но не больше maxBytes: Content-Length больше предела — отказ до
 * чтения; при чтении потока счётчик байтов, превышение — reader.cancel() и SpreadsheetError('too_large').
 * Пустое тело — SpreadsheetError('empty'). multipart не поддерживается (D-112).
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  void req;
  void maxBytes;
  throw new Error(TODO);
}

/**
 * Тип по сигнатуре: PK\x03\x04 → центральный каталог (пределы, без ZIP64, безопасные имена) →
 * [Content_Types].xml → classifyOoxml (xlsx | macro | иное → bad_type); D0 CF 11 E0 → legacy_xls;
 * %PDF, PNG, JPEG, GIF, RIFF, NUL в голове → bad_type; BOM UTF-16/32 → unsupported_encoding;
 * иначе CSV: BOM UTF-8 или валидный UTF-8 (TextDecoder fatal) → 'utf-8', иначе 'windows-1251'.
 */
export function sniffSpreadsheet(buf: Uint8Array, limits: SpreadsheetLimits): Sniffed {
  void buf;
  void limits;
  throw new Error(TODO);
}

/** Имена листов книги в порядке workbook.xml (скрытые тоже, с пометкой не нужны). */
export function listXlsxSheets(buf: Uint8Array, limits: SpreadsheetLimits): string[] {
  void buf;
  void limits;
  throw new Error(TODO);
}

/**
 * Файл → сетка строк. Порядок: семафор разборов (FILE_LIMITS.concurrentParses, занято → 'busy') →
 * sniffSpreadsheet → CSV: декодирование и core imports.parseCsvRecords; XLSX: workbook.xml и rels →
 * выбранный лист, sharedStrings, styles (даты) через saxes, DOCTYPE → 'xml_doctype' → пределы
 * строк, колонок и длины ячейки → sha256. Бросает SpreadsheetError; другие ошибки — баг.
 */
export async function readSpreadsheet(buf: Uint8Array, opts: ReadSpreadsheetOptions): Promise<SpreadsheetResult> {
  void buf;
  void opts;
  throw new Error(TODO);
}

/**
 * Ячейка CSV для Excel: строка, начинающаяся с = + - @ TAB CR (после пробелов тоже), получает ведущий
 * апостроф (защита от формул); «;», кавычка, перевод строки — в кавычках с удвоением кавычек.
 */
export function csvCell(value: CsvCellValue): string {
  void value;
  throw new Error(TODO);
}

/** Сетка → CSV для Excel русской локали: BOM UTF-8, разделитель «;», CRLF, каждая ячейка через csvCell. */
export function toExcelCsv(grid: readonly (readonly CsvCellValue[])[]): string {
  void grid;
  throw new Error(TODO);
}
