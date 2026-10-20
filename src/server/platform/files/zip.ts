// Чтение ZIP из буфера в памяти с защитой от бомб (дизайн C4d §3.3, D-111).
// Источник идеи: платформа LMS 2cd8a2b src/lib/storage/zip.ts, переписано с FileHandle на Uint8Array.
// Читаем только центральный каталог и те записи, которые запросили; остальное не распаковывается.
// Предел распаковки = объявленный размер записи (он уже ограничен пределом части): лживый размер даёт
// ошибку inflate и код corrupt, а не гигабайты в памяти.
import { inflateRawSync } from 'node:zlib';
import { SpreadsheetError, type SpreadsheetLimits } from './types';

export interface ZipEntry {
  name: string;
  /** 0 — без сжатия, 8 — deflate. */
  method: number;
  compressedSize: number;
  /** Объявленный размер после распаковки. */
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

const view = (buf: Uint8Array) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

/** Имя безопасно: не пустое, без NUL, `..`-сегментов, обратных слэшей и абсолютного пути. */
export function safeEntryName(name: string): boolean {
  if (name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/')) return false;
  return !name.split('/').includes('..');
}

/** Центральный каталог. Бросает SpreadsheetError('corrupt' | 'zip_limits'). */
export function readZipDirectory(buf: Uint8Array, limits: Pick<SpreadsheetLimits, 'zipMaxEntries' | 'zipMaxCentralDirBytes'>): ZipEntry[] {
  if (buf.length < EOCD_MIN) throw new SpreadsheetError('corrupt');
  const dv = view(buf);
  // EOCD ищем с конца: после него может быть комментарий до 64 КиБ
  let eocd = -1;
  const lowest = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= lowest; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpreadsheetError('corrupt');
  // ZIP64: локатор стоит прямо перед EOCD
  if (eocd >= 20 && dv.getUint32(eocd - 20, true) === SIG_EOCD64_LOCATOR) throw new SpreadsheetError('zip_limits');
  const total = dv.getUint16(eocd + 10, true);
  const dirSize = dv.getUint32(eocd + 12, true);
  const dirOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new SpreadsheetError('zip_limits');
  if (total > limits.zipMaxEntries || dirSize > limits.zipMaxCentralDirBytes) throw new SpreadsheetError('zip_limits');
  if (dirOffset + dirSize > eocd) throw new SpreadsheetError('zip_limits');
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  const end = dirOffset + dirSize;
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (p + 46 > end || dv.getUint32(p, true) !== SIG_CENTRAL) throw new SpreadsheetError('corrupt');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw new SpreadsheetError('corrupt');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new SpreadsheetError('zip_limits');
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (!safeEntryName(name)) throw new SpreadsheetError('zip_limits');
    // Зашифрованная запись (бит 0) не читается
    if (flags & 1) throw new SpreadsheetError('corrupt');
    if (method !== 0 && method !== 8) throw new SpreadsheetError('corrupt');
    entries.push({ name, method, compressedSize, size, localOffset });
    p = next;
  }
  return entries;
}

/** Общий счётчик распакованного по всем прочитанным частям одной книги. */
export interface InflateBudget {
  used: number;
  readonly max: number;
}

export const newBudget = (max: number): InflateBudget => ({ used: 0, max });

/**
 * Распаковка одной записи. `partMax` — предел части (FILE_LIMITS); объявленный размер больше него —
 * zip_limits ещё до чтения. Размер после распаковки обязан совпасть с объявленным.
 */
export function inflateEntry(buf: Uint8Array, entry: ZipEntry, partMax: number, budget: InflateBudget): Uint8Array {
  if (entry.size > partMax) throw new SpreadsheetError('zip_limits');
  budget.used += entry.size;
  if (budget.used > budget.max) throw new SpreadsheetError('zip_limits');
  const dv = view(buf);
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || dv.getUint32(lo, true) !== SIG_LOCAL) throw new SpreadsheetError('corrupt');
  const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
  const stop = start + entry.compressedSize;
  if (stop > buf.length) throw new SpreadsheetError('corrupt');
  const raw = buf.subarray(start, stop);
  if (entry.method === 0) {
    if (raw.length !== entry.size) throw new SpreadsheetError('corrupt');
    return raw;
  }
  if (entry.size === 0) return new Uint8Array(0);
  let out: Buffer;
  try {
    out = inflateRawSync(raw, { maxOutputLength: entry.size });
  } catch {
    // лживый размер (бомба) или битый поток
    throw new SpreadsheetError('corrupt');
  }
  if (out.length !== entry.size) throw new SpreadsheetError('corrupt');
  return out;
}
