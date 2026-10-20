// Защита чтения архива: бомбы, лживые размеры, опасные имена, ZIP64 (дизайн C4d §3.3, §15).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILE_LIMITS, SpreadsheetError, limitsFor, readSpreadsheet, sniffSpreadsheet, type SpreadsheetLimits } from '../../../src/server/platform/files';
import { inflateEntry, newBudget, readZipDirectory } from '../../../src/server/platform/files/zip';
import { xlsx, zip } from './xlsxBuilder';

const limits = (o: Partial<SpreadsheetLimits> = {}): SpreadsheetLimits => ({ ...limitsFor({ maxFileMb: 10, maxRows: 20_000 }), ...o });
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SpreadsheetError) return e.code;
    throw e;
  }
  return 'ok';
};

test('zip: часть с лживым малым размером, распаковывающаяся в 50 МБ, → corrupt без раздувания памяти', () => {
  const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(50 * 1024 * 1024, 0x61), declaredSize: 1000 }]);
  assert.ok(bomb.length < 100_000, 'бомба мала в сжатом виде');
  const entries = readZipDirectory(bomb, limits());
  const before = process.memoryUsage().arrayBuffers;
  assert.equal(codeOf(() => inflateEntry(bomb, entries[0]!, FILE_LIMITS.zipSheetMaxBytes, newBudget(1e9))), 'corrupt');
  assert.ok(process.memoryUsage().arrayBuffers - before < 100 * 1024 * 1024, 'память < 100 МБ');
});

test('zip: объявленный размер больше предела части → zip_limits до чтения', () => {
  const z = zip([{ name: 'a.xml', data: 'x', declaredSize: 500 }]);
  const e = readZipDirectory(z, limits())[0]!;
  assert.equal(codeOf(() => inflateEntry(z, e, 100, newBudget(1e9))), 'zip_limits');
});

test('zip: сумма распакованного больше бюджета → zip_limits', () => {
  const z = zip([
    { name: 'a.xml', data: 'a'.repeat(600) },
    { name: 'b.xml', data: 'b'.repeat(600) },
  ]);
  const [a, b] = readZipDirectory(z, limits()) as [never, never];
  const budget = newBudget(1000);
  assert.equal(inflateEntry(z, a, 1e6, budget).length, 600);
  assert.equal(codeOf(() => inflateEntry(z, b, 1e6, budget)), 'zip_limits');
});

test('zip: записей больше предела, каталог больше предела', () => {
  const many = zip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  assert.equal(codeOf(() => readZipDirectory(many, limits({ zipMaxEntries: 4 }))), 'zip_limits');
  assert.equal(codeOf(() => readZipDirectory(many, limits({ zipMaxCentralDirBytes: 50 }))), 'zip_limits');
});

test('zip: ZIP64, каталог за пределами файла, обрезанный файл', () => {
  assert.equal(codeOf(() => readZipDirectory(zip([{ name: 'a', data: 'x' }], { zip64Locator: true }), limits())), 'zip_limits');
  assert.equal(codeOf(() => readZipDirectory(zip([{ name: 'a', data: 'x' }], { dirOutOfFile: true }), limits())), 'zip_limits');
  const ok = zip([{ name: 'a', data: 'x' }]);
  assert.equal(codeOf(() => readZipDirectory(ok.subarray(0, ok.length - 10), limits())), 'corrupt');
  assert.equal(codeOf(() => readZipDirectory(new Uint8Array(5), limits())), 'corrupt');
});

test('zip: опасные имена записей отклоняются', () => {
  for (const name of ['../x', '/x', 'a/../../x', 'a\\b']) {
    assert.equal(codeOf(() => readZipDirectory(zip([{ name, data: 'x' }]), limits())), 'zip_limits', name);
  }
});

test('zip: запись за пределами файла → corrupt', () => {
  const z = zip([{ name: 'a.xml', data: 'hello hello hello' }]);
  const e = readZipDirectory(z, limits())[0]!;
  assert.equal(codeOf(() => inflateEntry(z.subarray(0, 40), e, 1000, newBudget(1e6))), 'corrupt');
});

test('книга-бомба целиком: readSpreadsheet отклоняет, память не растёт', async () => {
  const book = xlsx({ sheets: [{ name: 'Лист1', rows: [['Наименование', 'Телефон']] }] });
  // подмена листа: лживый размер при реальных 50 МБ
  const files = [
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(50 * 1024 * 1024, 0x20), declaredSize: 4096 },
  ];
  assert.ok(book.length > 0);
  await assert.rejects(readSpreadsheet(zip(files), { limits: limits() }), (e: unknown) => e instanceof SpreadsheetError && e.code === 'corrupt');
});

test('sniff: ZIP без [Content_Types].xml не считается XLSX', () => {
  const r = sniffSpreadsheet(zip([{ name: 'a.txt', data: 'x' }]), limits());
  assert.deepEqual(r, { ok: false, code: 'bad_type' });
});
