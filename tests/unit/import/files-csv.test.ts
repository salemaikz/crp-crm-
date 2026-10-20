// CSV: разделитель после баннера, кодировки, пределы; csvCell; чтение тела запроса (дизайн C4d §3.1, §3.5, §3.6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpreadsheetError, csvCell, limitsFor, readBodyLimited, readSpreadsheet, toExcelCsv, type SpreadsheetLimits } from '../../../src/server/platform/files';

const limits = (o: Partial<SpreadsheetLimits> = {}): SpreadsheetLimits => ({ ...limitsFor({ maxFileMb: 10, maxRows: 20_000 }), ...o });
const fails = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof SpreadsheetError && e.code === code, `ждали ${code}`);

test('csv: баннер без разделителей + заголовки с «;»', async () => {
  const text = 'Журнал первого касания, выгрузка 20.10\r\nТип;Наименование;Телефон\r\nТОО;"Альфа";+7 709 111 22 33\r\n';
  const r = await readSpreadsheet(Buffer.from(text), { limits: limits() });
  assert.equal(r.kind, 'csv');
  assert.equal(r.encoding, 'utf-8');
  assert.deepEqual(r.grid[1], ['Тип', 'Наименование', 'Телефон']);
  assert.deepEqual(r.grid[2], ['ТОО', 'Альфа', '+7 709 111 22 33']);
});

test('csv: перевод строки внутри кавычек остаётся в ячейке, номера строк не едут', async () => {
  const r = await readSpreadsheet(Buffer.from('a;b\r\n"x\ny";z\r\nq;w\r\n'), { limits: limits() });
  assert.equal(r.grid.length, 3);
  assert.equal(r.grid[1]![0], 'x\ny');
});

test('csv: Windows-1251', async () => {
  const bytes = Buffer.from([0xd2, 0xe8, 0xef, 0x3b, 0xcd, 0xe0, 0xe8, 0xec, 0x0d, 0x0a, 0xd2, 0xce, 0xce, 0x3b, 0xc0, 0xeb, 0xfc, 0xf4, 0xe0, 0x0d, 0x0a]);
  const r = await readSpreadsheet(bytes, { limits: limits() });
  assert.equal(r.encoding, 'windows-1251');
  assert.deepEqual(r.grid, [['Тип', 'Наим'], ['ТОО', 'Альфа']]);
});

test('csv: строк больше предела → too_many_rows; колонки и длина ячейки', async () => {
  const many = Array.from({ length: 30 }, (_, i) => `a${i};b`).join('\n');
  await fails(readSpreadsheet(Buffer.from(many), { limits: limits({ maxRows: 10 }) }), 'too_many_rows');
  const wide = Array.from({ length: 70 }, (_, i) => `c${i}`).join(';') + '\n' + 'x'.repeat(5000) + ';\u0001y\n';
  const r = await readSpreadsheet(Buffer.from(wide), { limits: limits() });
  assert.equal(r.grid[0]!.length, 64);
  assert.equal(r.stats.droppedColumns, 6);
  assert.equal(r.grid[1]![0]!.length, 4000);
  assert.equal(r.stats.truncatedCells, 1);
  assert.equal(r.grid[1]![1], 'y', 'управляющий символ удалён');
});

test('csv: пустой и PDF отклоняются', async () => {
  await fails(readSpreadsheet(new Uint8Array(0), { limits: limits() }), 'empty');
  await fails(readSpreadsheet(Buffer.from('%PDF-1.4 x'), { limits: limits() }), 'bad_type');
});

test('csvCell: формулы получают апостроф, кавычки и «;» экранируются', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+7 709 111 22 33'), "'+7 709 111 22 33");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\t=cmd'), "'\t=cmd");
  assert.equal(csvCell('\r=cmd'), `"'\r=cmd"`);
  assert.equal(csvCell('  =1'), "'  =1");
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell(5), '5');
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('обычный'), 'обычный');
});

test('toExcelCsv: BOM, «;», CRLF', () => {
  assert.equal(toExcelCsv([['a', 'b;c'], [1, '=x']]), '﻿a;"b;c"\r\n1;\'=x\r\n');
});

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://crm.test/api/import/uploads', { method: 'POST', body, headers, ...(body ? { duplex: 'half' } : {}) } as RequestInit);

test('body: Content-Length больше предела → 413 без чтения', async () => {
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled = true;
      c.enqueue(new Uint8Array(10));
    },
  });
  await fails(readBodyLimited(req(stream, { 'content-length': '1000' }), 100), 'too_large');
  assert.equal(pulled, false);
});

test('body: поток больше предела (без Content-Length) → отмена', async () => {
  let cancelled = false;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      sent += 40;
      c.enqueue(new Uint8Array(40));
    },
    cancel() {
      cancelled = true;
    },
  });
  await fails(readBodyLimited(req(stream), 100), 'too_large');
  assert.equal(cancelled, true);
  assert.ok(sent <= 400, 'не читали бесконечно');
});

test('body: пустое тело → empty; нормальное тело читается целиком', async () => {
  await fails(readBodyLimited(req(null), 100), 'empty');
  await fails(readBodyLimited(req(new Uint8Array(0)), 100), 'empty');
  assert.deepEqual([...(await readBodyLimited(req(Uint8Array.of(1, 2, 3)), 100))], [1, 2, 3]);
});
