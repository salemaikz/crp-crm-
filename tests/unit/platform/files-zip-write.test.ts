// Потоковый ZIP-писатель (R3b §2.2): архив читается своим читателем (readZipDirectory + inflateEntry), CRC и размеры
// верны, имя в UTF-8 (флаг 11), противодавление, предел размера, обрыв и отмена получателем. Только синтетика.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { collectStream, createZipWriter, toExcelCsvLines, ZipWriteError } from '../../../src/server/platform/files';
import { inflateEntry, newBudget, readZipDirectory } from '../../../src/server/platform/files/zip';

const LIMITS = { zipMaxEntries: 1000, zipMaxCentralDirBytes: 1 << 20 };
const enc = new TextEncoder();
const dec = new TextDecoder();

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield enc.encode(p);
}

test('запись → чтение: имена, содержимое, CRC, флаги 3 и 11, пустой файл', async () => {
  const z = createZipWriter({ modifiedAt: new Date(Date.UTC(2026, 9, 28, 14, 30, 0)) });
  const out = collectStream(z.stream);
  await z.addFile('manifest.json', enc.encode('{"a":1}'));
  await z.addFile('clients.csv', chunks(['id;name\r\n', 'c1;ТОО Пример\r\n', 'c2;+7 709 100 00 01\r\n']));
  await z.addFile('config/global.json', enc.encode(''));
  await z.finish();
  const buf = await out;
  const entries = readZipDirectory(buf, LIMITS);
  assert.deepEqual(entries.map((e) => e.name), ['manifest.json', 'clients.csv', 'config/global.json']);
  const budget = newBudget(1 << 24);
  const body = inflateEntry(buf, entries[1]!, 1 << 20, budget);
  assert.equal(dec.decode(body), 'id;name\r\nc1;ТОО Пример\r\nc2;+7 709 100 00 01\r\n');
  assert.equal(inflateEntry(buf, entries[2]!, 1 << 20, budget).length, 0);
  // CRC в каталоге совпадает с данными; флаги 0x0808 у локального заголовка
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(dv.getUint16(entries[1]!.localOffset + 6, true), 0x0808);
  const cdCrc = (() => {
    // центральная запись второго файла: ищем по сигнатуре и имени
    for (let i = buf.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x02014b50 && dec.decode(buf.subarray(i + 46, i + 46 + dv.getUint16(i + 28, true))) === 'clients.csv') return dv.getUint32(i + 16, true);
    }
    return -1;
  })();
  assert.equal(cdCrc, crc32(body));
});

test('большой файл идёт кусками и с противодавлением: в очереди не больше предела', async () => {
  const z = createZipWriter({ highWaterMarkBytes: 16 * 1024 });
  const row = 'x'.repeat(1000) + '\r\n';
  let produced = 0;
  async function* big(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 2000; i++) {
      produced++;
      // случайные данные плохо жмутся — проверяем поток, а не степень сжатия
      yield enc.encode(row + Math.random().toString(36).repeat(20));
    }
  }
  const writing = z.addFile('big.csv', big()).then(() => z.finish());
  // получатель ещё не читал: производитель должен остановиться далеко до конца
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(produced < 2000, `производитель не ждал получателя: ${produced}`);
  const buf = await collectStream(z.stream);
  await writing;
  const [e] = readZipDirectory(buf, LIMITS);
  assert.equal(e?.name, 'big.csv');
  assert.ok((e?.size ?? 0) > 2_000_000);
});

test('предел архива: abort too_large, получатель видит ошибку', async () => {
  const z = createZipWriter({ maxTotalBytes: 2000 });
  const reading = collectStream(z.stream);
  const noise = (n: number) => enc.encode(Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join(''));
  await assert.rejects(z.addFile('a.csv', noise(500)), (e: unknown) => e instanceof ZipWriteError && e.code === 'too_large');
  await assert.rejects(reading, (e: unknown) => e instanceof ZipWriteError && e.code === 'too_large');
});

test('имена: только безопасные; запись по очереди', async () => {
  const z = createZipWriter();
  void collectStream(z.stream).catch(() => undefined);
  await assert.rejects(z.addFile('../etc/passwd', enc.encode('x')), (e: unknown) => e instanceof ZipWriteError && e.code === 'bad_name');
  const z2 = createZipWriter();
  void collectStream(z2.stream).catch(() => undefined);
  await assert.rejects(z2.addFile('клиенты.csv', enc.encode('x')), (e: unknown) => e instanceof ZipWriteError && e.code === 'bad_name');
  const z3 = createZipWriter();
  void collectStream(z3.stream).catch(() => undefined);
  const first = z3.addFile('a.csv', chunks(['1', '2']));
  await assert.rejects(z3.addFile('b.csv', enc.encode('x')), (e: unknown) => e instanceof ZipWriteError && e.code === 'sequence');
  await first.catch(() => undefined);
});

test('получатель отменил чтение: запись прекращается с cancelled', async () => {
  const z = createZipWriter({ highWaterMarkBytes: 1024 });
  async function* endless(): AsyncGenerator<Uint8Array> {
    for (;;) yield enc.encode(Math.random().toString(36).repeat(50));
  }
  const writing = z.addFile('x.csv', endless());
  const reader = z.stream.getReader();
  await reader.read();
  await reader.cancel();
  await assert.rejects(writing, (e: unknown) => e instanceof ZipWriteError && e.code === 'cancelled');
});

test('ошибка источника данных обрывает архив (получатель не получит «целый» файл)', async () => {
  const z = createZipWriter();
  const reading = collectStream(z.stream);
  async function* broken(): AsyncGenerator<Uint8Array> {
    yield enc.encode('id\r\n');
    throw new Error('db down');
  }
  await assert.rejects(z.addFile('a.csv', broken()), /db down/);
  await assert.rejects(reading, (e: unknown) => e instanceof ZipWriteError && e.code === 'source');
});

test('toExcelCsvLines: BOM один раз, «;», CRLF, формулы обезврежены', async () => {
  async function* rows() {
    yield ['id', 'name'];
    yield ['c1', '=SUM(A1)'];
    yield ['c2', '+7 709 100 00 01'];
    yield [3, null];
  }
  // ignoreBOM: декодер по умолчанию съедает BOM, а нам надо видеть, что он есть
  const keep = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = '';
  for await (const c of toExcelCsvLines(rows(), { chunkChars: 8 })) text += keep.decode(c);
  assert.equal(text, "﻿id;name\r\nc1;'=SUM(A1)\r\nc2;'+7 709 100 00 01\r\n3;\r\n");
});
