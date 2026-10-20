// Чтение загруженных таблиц (CSV, XLSX) для импорта: типы, коды ошибок, лимиты.
// Дизайн — docs/import-design.md §3 (C4d), решения D-111, D-112. Файл на диск не пишется и не хранится:
// всё читается из буфера в памяти (≤ import.maxFileMb), архив XLSX не распаковывается целиком —
// читаются только нужные части с жёстким пределом на выход inflate.

export type SpreadsheetKind = 'csv' | 'xlsx';

/** Кодировки CSV, которые понимаем: Excel «CSV UTF-8» и «CSV (разделители)» русской Windows. */
export type CsvEncoding = 'utf-8' | 'windows-1251';

const MiB = 1024 * 1024;

/** Жёсткие пределы кода. Настройки установки (import.maxFileMb, import.maxRows) их только сужают. */
export const FILE_LIMITS = {
  /** Потолок тела запроса при любой настройке (nginx режет на 10m — DEPLOY, crm.conf). */
  maxBytesHard: 25 * MiB,
  /** Голова файла для определения типа. */
  sniffHeadBytes: 64 * 1024,
  zipMaxEntries: 1_000,
  zipMaxCentralDirBytes: 1 * MiB,
  /** [Content_Types].xml, xl/workbook.xml, xl/_rels/workbook.xml.rels. */
  zipSmallPartMaxBytes: 1 * MiB,
  /** xl/styles.xml (форматы дат). */
  zipStylesMaxBytes: 4 * MiB,
  /** xl/sharedStrings.xml. */
  zipSharedStringsMaxBytes: 32 * MiB,
  /** Выбранный лист xl/worksheets/*.xml. */
  zipSheetMaxBytes: 64 * MiB,
  /** Сумма распакованного по всем прочитанным частям. */
  zipTotalInflatedMaxBytes: 96 * MiB,
  sharedStringsMaxCount: 1_000_000,
  /** Колонки дальше этой отбрасываются (счётчик droppedColumns). */
  maxCols: 64,
  /** Длиннее — обрезается (счётчик truncatedCells). */
  maxCellChars: 4_000,
  /** Строк сверх import.maxRows на баннер, заголовки и пустые строки. */
  rowsSlack: 50,
  /** Одновременных разборов в процессе (CPU и память веб-процесса). */
  concurrentParses: 1,
} as const;

/** Пределы одного чтения: из FILE_LIMITS и настроек установки (CONFIG §6.13). Тесты передают свои. */
export interface SpreadsheetLimits {
  maxBytes: number;
  /** Данные + rowsSlack: номер строки листа больше этого — ошибка too_many_rows. */
  maxRows: number;
  maxCols: number;
  maxCellChars: number;
  zipMaxEntries: number;
  zipMaxCentralDirBytes: number;
  zipSmallPartMaxBytes: number;
  zipStylesMaxBytes: number;
  zipSharedStringsMaxBytes: number;
  zipSheetMaxBytes: number;
  zipTotalInflatedMaxBytes: number;
  sharedStringsMaxCount: number;
}

/**
 * Коды отказа. Текст пользователю — из messages/ru/import.json по коду; в лог и аудит — только код.
 * - too_large — тело больше maxBytes (413);
 * - empty — пустой файл;
 * - bad_type — не CSV и не XLSX по сигнатуре (PDF, картинки, DOCX, ODS, XLSB, двоичный мусор);
 * - legacy_xls — OLE2 (старый .xls или зашифрованный XLSX): «сохраните как XLSX или CSV»;
 * - macro — XLSM, vbaProject.bin, activeX;
 * - corrupt — архив или XML битые, короткое чтение, запись за пределами файла;
 * - zip_limits — ZIP64, записей или каталога больше предела, часть больше предела, опасное имя;
 * - xml_doctype — в части XLSX есть DOCTYPE/ENTITY (не разбираем вовсе);
 * - unsupported_encoding — CSV не UTF-8 и не Windows-1251 (например UTF-16);
 * - sheet_required — в книге больше одного листа, лист не выбран (detail.sheets);
 * - sheet_not_found — выбранного листа нет;
 * - too_many_rows — строк больше maxRows;
 * - busy — уже идёт другой разбор (429).
 */
export type SpreadsheetErrorCode =
  | 'too_large'
  | 'empty'
  | 'bad_type'
  | 'legacy_xls'
  | 'macro'
  | 'corrupt'
  | 'zip_limits'
  | 'xml_doctype'
  | 'unsupported_encoding'
  | 'sheet_required'
  | 'sheet_not_found'
  | 'too_many_rows'
  | 'busy';

export class SpreadsheetError extends Error {
  constructor(
    readonly code: SpreadsheetErrorCode,
    /** Только для sheet_required/sheet_not_found: имена листов книги. Значений ячеек здесь нет никогда. */
    readonly sheets?: readonly string[],
  ) {
    super(`spreadsheet: ${code}`);
    this.name = 'SpreadsheetError';
  }
}

/** Тип по сигнатуре, а не по расширению и не по Content-Type. */
export type Sniffed =
  | { ok: true; kind: 'xlsx' }
  | { ok: true; kind: 'csv'; encoding: CsvEncoding }
  | { ok: false; code: Extract<SpreadsheetErrorCode, 'empty' | 'bad_type' | 'legacy_xls' | 'macro' | 'corrupt' | 'zip_limits' | 'unsupported_encoding'> };

export interface ReadSpreadsheetOptions {
  /** Имя листа или номер с 0; не задан — единственный лист книги (иначе sheet_required). Для CSV игнорируется. */
  sheet?: string | number;
  limits: SpreadsheetLimits;
}

/** Счётчики чтения: идут в imports.report (без значений ячеек). */
export interface SpreadsheetStats {
  /** Строк в сетке (с баннером, заголовками и пустыми). */
  rows: number;
  truncatedCells: number;
  droppedColumns: number;
  /** Ячейки с формулой без сохранённого значения: читаются как пустые. */
  formulaWithoutValue: number;
  /** Ячейки-ошибки (#N/A и т. п.): читаются как пустые. */
  errorCells: number;
}

export interface SpreadsheetResult {
  kind: SpreadsheetKind;
  encoding: CsvEncoding | null;
  /** Имена листов книги (для CSV — пусто). */
  sheets: readonly string[];
  sheetIndex: number;
  /**
   * Сетка строк. Индекс = номер строки листа − 1: пропущенные в XLSX строки (`<row r>`) заполняются
   * пустыми, иначе сдвинется владелец «диапазон строк → оператор». Ячейки — строки: число — как в
   * `<v>` (без экспоненты и потери цифр), дата по формату ячейки — 'YYYY-MM-DD' или 'YYYY-MM-DD HH:MM',
   * формула — сохранённое значение, сама формула не читается и не вычисляется.
   */
  grid: string[][];
  stats: SpreadsheetStats;
  /** sha256 исходных байтов, hex (imports.file_sha256). */
  sha256: string;
}

/** Ячейка CSV-выгрузки, безопасная для Excel: см. csvCell в index.ts. */
export type CsvCellValue = string | number | null | undefined;
