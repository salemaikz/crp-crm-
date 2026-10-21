// Потоковый ZIP-писатель (дизайн R3b §2.2, D-264): полная выгрузка и XLSX. Без зависимостей: deflate raw и crc32 из
// node:zlib. Файлы пишутся по очереди: локальный заголовок с флагами 3 (размеры — в дескрипторе после данных) и 11
// (имя UTF-8), данные deflate, дескриптор; в конце центральный каталог. ZIP64 нет: архив больше предела → abort.
// Противодавление: тело отдаётся через ReadableStream, запись ждёт, пока получатель заберёт данные, —
// файл целиком в памяти не копится.
import { crc32, createDeflateRaw } from 'node:zlib';
import { safeEntryName } from './zip';

/** Предел архива без ZIP64: смещения и размеры обязаны помещаться в uint32 (с запасом). */
export const ZIP_MAX_TOTAL_BYTES = 3_500_000_000;
const ZIP_MAX_ENTRIES = 0xffff;
const UINT32_MAX = 0xffffffff;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
/** Бит 3 — размеры и CRC в дескрипторе после данных; бит 11 — имя в UTF-8. */
const FLAGS = 0x0808;
const METHOD_DEFLATE = 8;
const VERSION = 20;

/** Имя части архива: латиница, цифры и `_ . / - [ ]` (XLSX требует `[Content_Types].xml`), без `..` и абсолютных путей. */
const NAME = /^[A-Za-z0-9_.[\]/-]{1,200}$/;

/** Ошибка записи архива: код без текста (в лог — только код). */
export class ZipWriteError extends Error {
  constructor(readonly code: string) {
    super(`zip:${code}`);
    this.name = 'ZipWriteError';
  }
}

export interface ZipWriter {
  /** Добавить файл. Файлы — строго по очереди (следующий addFile — после завершения предыдущего). */
  addFile(name: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void>;
  /** Центральный каталог и конец потока. */
  finish(): Promise<void>;
  /** Оборвать поток с кодом (получатель увидит ошибку чтения, архив неполный). */
  abort(code: string): void;
  stream: ReadableStream<Uint8Array>;
}

export interface ZipWriterOptions {
  /** Предел всего архива в байтах; по умолчанию ZIP_MAX_TOTAL_BYTES. */
  maxTotalBytes?: number;
  /** Время изменения файлов (берутся UTC-поля: вызывающий передаёт местное время как UTC). */
  modifiedAt?: Date;
  /** Сколько байт держать в очереди потока, пока получатель не заберёт; по умолчанию 256 КБ. */
  highWaterMarkBytes?: number;
}

type Entry = { name: Uint8Array; crc: number; compressed: number; size: number; offset: number };

/** Дата и время MS-DOS (точность 2 с, годы с 1980). */
function dosDateTime(d: Date): { date: number; time: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
  };
}

async function* chunksOf(body: Uint8Array | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    // большой буфер режем, чтобы противодавление работало и для него
    const step = 64 * 1024;
    for (let i = 0; i < body.length; i += step) yield body.subarray(i, i + step);
    return;
  }
  for await (const c of body) yield c;
}

export function createZipWriter(opts: ZipWriterOptions = {}): ZipWriter {
  const maxTotal = Math.min(opts.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES, ZIP_MAX_TOTAL_BYTES);
  const stamp = dosDateTime(opts.modifiedAt ?? new Date());
  const entries: Entry[] = [];
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let offset = 0;
  let failed: ZipWriteError | null = null;
  let busy = false;
  let finished = false;
  let waiters: (() => void)[] = [];

  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        wake();
      },
      cancel() {
        // получатель закрыл соединение: запись прекращается на следующем куске
        failed ??= new ZipWriteError('cancelled');
        wake();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: opts.highWaterMarkBytes ?? 256 * 1024 }),
  );

  const fail = (code: string): ZipWriteError => {
    if (!failed) {
      failed = new ZipWriteError(code);
      try {
        controller.error(failed);
      } catch {
        // поток уже закрыт или отменён
      }
    }
    wake();
    return failed;
  };

  async function push(b: Uint8Array): Promise<void> {
    if (failed) throw failed;
    if (b.length === 0) return;
    if (offset + b.length > maxTotal) throw fail('too_large');
    controller.enqueue(b);
    offset += b.length;
    while (!failed && (controller.desiredSize ?? 0) <= 0) await new Promise<void>((r) => waiters.push(r));
    if (failed) throw failed;
  }

  function localHeader(name: Uint8Array): Uint8Array {
    const b = new Uint8Array(30 + name.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, SIG_LOCAL, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, FLAGS, true);
    v.setUint16(8, METHOD_DEFLATE, true);
    v.setUint16(10, stamp.time, true);
    v.setUint16(12, stamp.date, true);
    // CRC и размеры — нули: они в дескрипторе (бит 3)
    v.setUint16(26, name.length, true);
    v.setUint16(28, 0, true);
    b.set(name, 30);
    return b;
  }

  function descriptor(e: Entry): Uint8Array {
    const b = new Uint8Array(16);
    const v = new DataView(b.buffer);
    v.setUint32(0, SIG_DESCRIPTOR, true);
    v.setUint32(4, e.crc, true);
    v.setUint32(8, e.compressed, true);
    v.setUint32(12, e.size, true);
    return b;
  }

  function centralEntry(e: Entry): Uint8Array {
    const b = new Uint8Array(46 + e.name.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, SIG_CENTRAL, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, VERSION, true);
    v.setUint16(8, FLAGS, true);
    v.setUint16(10, METHOD_DEFLATE, true);
    v.setUint16(12, stamp.time, true);
    v.setUint16(14, stamp.date, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, e.compressed, true);
    v.setUint32(24, e.size, true);
    v.setUint16(28, e.name.length, true);
    // extra, comment, disk, attrs — нули
    v.setUint32(42, e.offset, true);
    b.set(e.name, 46);
    return b;
  }

  async function addFile(name: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    if (failed) throw failed;
    if (busy || finished) throw fail('sequence');
    if (!NAME.test(name) || !safeEntryName(name)) throw fail('bad_name');
    if (entries.length >= ZIP_MAX_ENTRIES) throw fail('too_many_entries');
    busy = true;
    try {
      const entry: Entry = { name: encoder.encode(name), crc: 0, compressed: 0, size: 0, offset };
      await push(localHeader(entry.name));
      const deflate = createDeflateRaw({ level: 6 });
      const out: Buffer[] = [];
      let zerr: Error | null = null;
      deflate.on('data', (b: Buffer) => out.push(b));
      deflate.on('error', (e: Error) => {
        zerr = e;
      });
      const drain = async () => {
        while (out.length > 0) {
          const b = out.shift() as Buffer;
          entry.compressed += b.length;
          await push(b);
        }
        if (zerr) throw fail('deflate');
      };
      try {
        for await (const chunk of chunksOf(body)) {
          if (failed) throw failed;
          if (chunk.length === 0) continue;
          entry.crc = crc32(chunk, entry.crc);
          entry.size += chunk.length;
          if (entry.size > UINT32_MAX) throw fail('too_large');
          await new Promise<void>((res, rej) => deflate.write(chunk, (e) => (e ? rej(e) : res())));
          await drain();
        }
        await new Promise<void>((res, rej) => {
          deflate.once('end', res);
          deflate.once('error', rej);
          deflate.end();
        });
        await drain();
      } finally {
        deflate.removeAllListeners('data');
        if (!deflate.destroyed) deflate.destroy();
      }
      if (entry.compressed > UINT32_MAX) throw fail('too_large');
      await push(descriptor(entry));
      entries.push(entry);
    } catch (e) {
      // ошибка источника данных (БД, генератор) — архив обрывается, получатель не увидит «целый» файл
      if (!failed) fail('source');
      throw e;
    } finally {
      busy = false;
    }
  }

  async function finish(): Promise<void> {
    if (failed) throw failed;
    if (busy || finished) throw fail('sequence');
    finished = true;
    const dirOffset = offset;
    for (const e of entries) await push(centralEntry(e));
    const dirSize = offset - dirOffset;
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, SIG_EOCD, true);
    v.setUint16(8, entries.length, true);
    v.setUint16(10, entries.length, true);
    v.setUint32(12, dirSize, true);
    v.setUint32(16, dirOffset, true);
    await push(end);
    controller.close();
  }

  return {
    addFile,
    finish,
    abort: (code: string) => {
      fail(code);
    },
    stream,
  };
}

/** Прочитать поток целиком (XLSX собирается в буфер: он маленький и ограничен числом строк). */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
