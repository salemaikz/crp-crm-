// XLSX-писатель (R3b §2.2, D-263): круговой тест через свой readXlsx, строки только inlineStr, формул нет вообще,
// похожее на формулу — с quotePrefix, запрещённые XML-символы вырезаны, предел ячейки и строк. Только синтетика.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitsFor, readSpreadsheet, writeXlsx, XLSX_MAX_CELL_CHARS, XLSX_MAX_ROWS, XlsxWriteError, type XlsxTable } from '../../../src/server/platform/files';
import { inflateEntry, newBudget, readZipDirectory } from '../../../src/server/platform/files/zip';
import { cellText, columnName, sheetNameOf, xmlEscape } from '../../../src/server/platform/files/xlsxWrite';

const LIMITS = limitsFor({ maxFileMb: 10, maxRows: 200_000 });
const dec = new TextDecoder();

function part(buf: Uint8Array, name: string): string {
  const e = readZipDirectory(buf, LIMITS).find((x) => x.name === name);
  assert.ok(e, `нет части ${name}`);
  return dec.decode(inflateEntry(buf, e, 1 << 26, newBudget(1 << 27)));
}

const table: XlsxTable = {
  columns: [
    { label: 'Оператор', type: 'text' },
    { label: 'Итогов', type: 'int' },
    { label: 'Сумма', type: 'money' },
    { label: 'Явка', type: 'percent' },
    { label: 'День', type: 'day' },
  ],
  rows: [
    ['Оператор А', 12, 1_500_000, 12.5, '2026-10-12'],
    ['=1+1', 0, 0, null, '2026-10-13'],
    ['+7 709 100 00 01', 3, 10, 0, ''],
    ['-5', 1, 1, 1, ''],
    ['@x', 1, 1, 1, ''],
    ['a\u0001b\u0000c & <d> "e" \'f\'', null, null, null, null],
  ],
};

test('круговой тест: значения и числа читаются обратно', async () => {
  const buf = await writeXlsx({ sheetName: 'Операторы', table });
  const r = await readSpreadsheet(buf, { limits: LIMITS });
  assert.equal(r.kind, 'xlsx');
  assert.deepEqual(r.sheets, ['Операторы']);
  assert.deepEqual(r.grid[0], ['Оператор', 'Итогов', 'Сумма', 'Явка', 'День']);
  assert.deepEqual(r.grid[1], ['Оператор А', '12', '1500000', '12.5', '2026-10-12']);
  assert.deepEqual(r.grid[2], ['=1+1', '0', '0', '', '2026-10-13']);
  assert.deepEqual(r.grid[6], ['abc & <d> "e" \'f\'']);
});

test('формул нет вообще: строки только inlineStr, похожие на формулу — со стилем quotePrefix', async () => {
  const buf = await writeXlsx({ sheetName: 'X', table });
  const sheet = part(buf, 'xl/worksheets/sheet1.xml');
  assert.ok(!/<f[ >]/.test(sheet), 'в листе есть <f>');
  assert.ok(!/t="s"/.test(sheet), 'общие строки не используются');
  // =1+1, +7…, -5, @x — стиль 2 (quotePrefix)
  for (const ref of ['A3', 'A4', 'A5', 'A6']) assert.match(sheet, new RegExp(`<c r="${ref}" t="inlineStr" s="2">`), ref);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t>Оператор А<\/t><\/is><\/c>/);
  assert.match(sheet, /<c r="C2" s="3"><v>1500000<\/v><\/c>/);
  assert.match(sheet, /<c r="D2" s="4"><v>12.5<\/v><\/c>/);
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  const styles = part(buf, 'xl/styles.xml');
  assert.match(styles, /quotePrefix="1"/);
  assert.match(styles, /formatCode="0.0"/);
  // заголовок жирный (стиль 1)
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/);
});

test('XML: экранирование, запрещённые символы, длина ячейки, имя листа', () => {
  assert.equal(xmlEscape(`<&>"'`), '&lt;&amp;&gt;&quot;&apos;');
  assert.equal(cellText('a\u0000\u0008\u000Bb\uD800c\t\n'), 'abc\t\n');
  assert.equal(cellText('😀'), '😀');
  const long = cellText('я'.repeat(XLSX_MAX_CELL_CHARS + 10));
  assert.equal(long.length, XLSX_MAX_CELL_CHARS);
  assert.ok(long.endsWith('…'));
  // пара суррогатов на границе не рвётся
  const emoji = cellText('a'.repeat(XLSX_MAX_CELL_CHARS - 2) + '😀😀');
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji));
  assert.equal(sheetNameOf('Отчёт: [операторы]/неделя*?'), 'Отчёт   операторы  неделя');
  assert.equal(sheetNameOf(''), 'Sheet1');
  assert.ok(sheetNameOf('я'.repeat(40)).length <= 31);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
});

test('строк больше предела — too_many_rows', async () => {
  const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, () => ['x']);
  await assert.rejects(writeXlsx({ sheetName: 'X', table: { columns: [{ label: 'a', type: 'text' }], rows } }), (e: unknown) => e instanceof XlsxWriteError && e.code === 'too_many_rows');
});
