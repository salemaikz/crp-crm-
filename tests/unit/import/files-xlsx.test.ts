// Разбор XLSX: общие строки, inlineStr, числа без потери цифр, даты, пропуски строк, колонки, DOCTYPE,
// формулы, листы (дизайн C4d §3.4, §15).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpreadsheetError, limitsFor, listXlsxSheets, readSpreadsheet, type SpreadsheetLimits } from '../../../src/server/platform/files';
import { xlsx, zip } from './xlsxBuilder';

const limits = (o: Partial<SpreadsheetLimits> = {}): SpreadsheetLimits => ({ ...limitsFor({ maxFileMb: 10, maxRows: 20_000 }), ...o });
const read = (b: Uint8Array, sheet?: string | number, l = limits()) => readSpreadsheet(b, { limits: l, ...(sheet === undefined ? {} : { sheet }) });
const fails = async (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof SpreadsheetError && e.code === code, `ждали ${code}`);

test('xlsx: общие строки, inlineStr и многострочные ячейки', async () => {
  for (const inline of [false, true]) {
    const r = await read(xlsx({ inline, sheets: [{ name: 'A', rows: [['Наименование', 'Заметка'], ['ТОО «Альфа»', 'строка 1\nстрока 2']] }] }));
    assert.equal(r.kind, 'xlsx');
    assert.deepEqual(r.grid, [['Наименование', 'Заметка'], ['ТОО «Альфа»', 'строка 1\nстрока 2']]);
    assert.equal(r.sha256.length, 64);
  }
});

test('xlsx: число 77091234567 не превращается в 7.7e10', async () => {
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [[77091234567, 12.5, '0012']] }] }));
  assert.deepEqual(r.grid, [['77091234567', '12.5', '0012']]);
});

test('xlsx: даты по формату ячейки (14, dd.mm.yyyy), date1904', async () => {
  // 46312 = 2026-10-17; .5 = 12:00
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [[{ date: 46312 }, { date: 46312.5 }]] }] }));
  assert.deepEqual(r.grid, [['2026-10-17', '2026-10-17 12:00']]);
  const r4 = await read(xlsx({ date1904: true, sheets: [{ name: 'A', rows: [[{ date: 46312 - 1462 }]] }] }));
  assert.deepEqual(r4.grid, [['2026-10-17']]);
  const strict = await read(xlsx({ strict: true, sheets: [{ name: 'A', rows: [[{ date: 46312 }]] }] }));
  assert.deepEqual(strict.grid, [['2026-10-17']], 'Strict-пространство имён и свой формат dd.mm.yyyy');
});

test('xlsx: пропущенные строки заполняются пустыми (владелец по диапазону не сдвигается)', async () => {
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [['a'], ['b']], rowNumbers: [2, 5] }] }));
  assert.deepEqual(r.grid, [[], ['a'], [], [], ['b']]);
  assert.equal(r.stats.rows, 5);
});

test('xlsx: колонка AA; колонка 65 отбрасывается и считается', async () => {
  const wide: (string | null)[] = Array(70).fill(null);
  wide[26] = 'AA';
  wide[64] = 'отброшена';
  wide[63] = 'последняя';
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [wide as string[]] }] }));
  assert.equal(r.grid[0]![26], 'AA');
  assert.equal(r.grid[0]![63], 'последняя');
  assert.equal(r.grid[0]!.length, 64);
  assert.equal(r.stats.droppedColumns, 1);
});

test('xlsx: номер строки больше предела → too_many_rows', async () => {
  await fails(read(xlsx({ sheets: [{ name: 'A', rows: [['a'], ['b']], rowNumbers: [1, 500] }] }), undefined, limits({ maxRows: 100 })), 'too_many_rows');
});

test('xlsx: DOCTYPE и ENTITY → xml_doctype', async () => {
  await fails(read(xlsx({ doctype: true, sheets: [{ name: 'A', rows: [['a']] }] })), 'xml_doctype');
});

test('xlsx: формула с сохранённым значением читается, без значения — пусто и счётчик', async () => {
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [[{ formula: '1+1', value: 2 }, { formula: 'HYPERLINK("x")' }, { error: '#N/A' }, { bool: true }]] }] }));
  assert.deepEqual(r.grid, [['2', '', '', '1']]);
  assert.equal(r.stats.formulaWithoutValue, 1);
  assert.equal(r.stats.errorCells, 1);
});

test('xlsx: два листа → sheet_required, выбор по имени и номеру; sheet_not_found', async () => {
  const b = xlsx({ sheets: [{ name: 'Основная', rows: [['x']] }, { name: 'Обработанные', rows: [['y']] }] });
  await assert.rejects(read(b), (e: unknown) => e instanceof SpreadsheetError && e.code === 'sheet_required' && e.sheets?.join('|') === 'Основная|Обработанные');
  assert.deepEqual((await read(b, 'Обработанные')).grid, [['y']]);
  assert.deepEqual((await read(b, 1)).grid, [['y']]);
  assert.deepEqual((await read(b, '0')).grid, [['x']]);
  await fails(read(b, 'Нет такого'), 'sheet_not_found');
  await fails(read(b, 5), 'sheet_not_found');
  assert.deepEqual(listXlsxSheets(b, limits()), ['Основная', 'Обработанные']);
});

test('xlsx: путь листа берётся из rels, а не sheet1.xml', async () => {
  const r = await read(xlsx({ sheetPath: () => 'xl/worksheets/data-7.xml', sheets: [{ name: 'A', rows: [['из rels']] }] }));
  assert.deepEqual(r.grid, [['из rels']]);
  const abs = await read(xlsx({ sheetPath: () => '/xl/worksheets/abs.xml', sheets: [{ name: 'A', rows: [['абс']] }] }));
  assert.deepEqual(abs.grid, [['абс']]);
});

test('xlsx: путь листа вне xl/ → corrupt', async () => {
  const b = xlsx({ relTarget: () => '../../etc/x.xml', sheets: [{ name: 'A', rows: [['x']] }] });
  await fails(read(b), 'corrupt');
  const outside = xlsx({ relTarget: () => '../docProps/s.xml', sheets: [{ name: 'A', rows: [['x']] }], extraFiles: [{ name: 'docProps/s.xml', data: '<worksheet/>' }] });
  await fails(read(outside), 'corrupt');
});

test('xlsx: ячейка длиннее предела обрезается', async () => {
  const r = await read(xlsx({ sheets: [{ name: 'A', rows: [['x'.repeat(5000), 'a\tc']] }] }));
  assert.equal(r.grid[0]![0]!.length, 4000);
  assert.equal(r.stats.truncatedCells, 1);
  assert.equal(r.grid[0]![1], 'a\tc');
});

test('xlsx: файл больше предела → too_large; битый XML листа → corrupt', async () => {
  const b = xlsx({ sheets: [{ name: 'A', rows: [['a']] }] });
  await fails(read(b, undefined, limits({ maxBytes: 100 })), 'too_large');
  const broken = zip([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>' },
    { name: 'xl/worksheets/s.xml', data: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</c></sheetData>' },
  ]);
  await fails(read(broken), 'corrupt');
});

test('read: второй одновременный разбор → busy', async () => {
  const b = xlsx({ sheets: [{ name: 'A', rows: [['a']] }] });
  const first = read(b);
  await fails(read(b), 'busy');
  assert.deepEqual((await first).grid, [['a']]);
  assert.deepEqual((await read(b)).grid, [['a']], 'семафор освобождён');
});
