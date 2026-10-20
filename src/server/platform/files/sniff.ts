// Тип загруженного файла по сигнатуре, а не по расширению и Content-Type (дизайн C4d §3.2).
import { classifyOoxml } from './ooxml';
import { inflateEntry, newBudget, readZipDirectory, type ZipEntry } from './zip';
import { FILE_LIMITS, SpreadsheetError, type CsvEncoding, type Sniffed, type SpreadsheetLimits } from './types';

type Failure = Extract<Sniffed, { ok: false }>['code'];
const FAILURES: ReadonlySet<string> = new Set<Failure>(['empty', 'bad_type', 'legacy_xls', 'macro', 'corrupt', 'zip_limits', 'unsupported_encoding']);

const startsWith = (buf: Uint8Array, sig: readonly number[]) => sig.every((b, i) => buf[i] === b);

export function contentTypesOf(buf: Uint8Array, entries: readonly ZipEntry[], limits: SpreadsheetLimits): string {
  const ct = entries.find((e) => e.name === '[Content_Types].xml');
  if (!ct) throw new SpreadsheetError('bad_type');
  const text = new TextDecoder().decode(inflateEntry(buf, ct, limits.zipSmallPartMaxBytes, newBudget(limits.zipTotalInflatedMaxBytes)));
  // Объявление типа/сущности в служебной части не читаем вовсе
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new SpreadsheetError('corrupt');
  return text;
}

/** Кодировка CSV: BOM UTF-8 или валидный UTF-8 — utf-8, иначе Windows-1251. */
function csvEncoding(buf: Uint8Array): CsvEncoding {
  if (startsWith(buf, [0xef, 0xbb, 0xbf])) return 'utf-8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'utf-8';
  } catch {
    return 'windows-1251';
  }
}

function sniffOrThrow(buf: Uint8Array, limits: SpreadsheetLimits): Sniffed {
  if (buf.length === 0) throw new SpreadsheetError('empty');
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const entries = readZipDirectory(buf, limits);
    const kind = classifyOoxml(entries, contentTypesOf(buf, entries, limits));
    if (kind === 'macro') throw new SpreadsheetError('macro');
    if (kind === 'other') throw new SpreadsheetError('bad_type');
    return { ok: true, kind: 'xlsx' };
  }
  if (startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) || startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) throw new SpreadsheetError('corrupt');
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) throw new SpreadsheetError('legacy_xls');
  // Текстовые BOM: UTF-16/32 содержат NUL, поэтому проверяются раньше двоичного мусора
  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff]) || startsWith(buf, [0x00, 0x00, 0xfe, 0xff])) {
    throw new SpreadsheetError('unsupported_encoding');
  }
  if (
    startsWith(buf, [0x25, 0x50, 0x44, 0x46]) || // %PDF
    startsWith(buf, [0x89, 0x50, 0x4e, 0x47]) || // PNG
    startsWith(buf, [0xff, 0xd8, 0xff]) || // JPEG
    startsWith(buf, [0x47, 0x49, 0x46, 0x38]) || // GIF8
    startsWith(buf, [0x52, 0x49, 0x46, 0x46]) // RIFF
  ) {
    throw new SpreadsheetError('bad_type');
  }
  const head = buf.subarray(0, Math.min(buf.length, FILE_LIMITS.sniffHeadBytes));
  if (head.includes(0)) throw new SpreadsheetError('bad_type');
  return { ok: true, kind: 'csv', encoding: csvEncoding(buf) };
}

/**
 * Тип по сигнатуре: PK → каталог ZIP (пределы, без ZIP64, безопасные имена) → [Content_Types].xml;
 * OLE2 → legacy_xls; PDF, картинки, NUL → bad_type; BOM UTF-16/32 → unsupported_encoding; иначе CSV.
 */
export function sniffSpreadsheet(buf: Uint8Array, limits: SpreadsheetLimits): Sniffed {
  try {
    return sniffOrThrow(buf, limits);
  } catch (e) {
    if (e instanceof SpreadsheetError && FAILURES.has(e.code)) return { ok: false, code: e.code as Failure };
    throw e;
  }
}
