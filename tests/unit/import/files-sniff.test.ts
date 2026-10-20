// Тип файла по сигнатуре (дизайн C4d §3.2): расширение и Content-Type не учитываются.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limitsFor, sniffSpreadsheet } from '../../../src/server/platform/files';
import { xlsx, zip } from './xlsxBuilder';

const limits = limitsFor({ maxFileMb: 10, maxRows: 20_000 });
const sniff = (b: Uint8Array | Buffer) => sniffSpreadsheet(b, limits);
const book = (extra: Parameters<typeof xlsx>[0]['extraFiles'] = [], ct = '') => xlsx({ sheets: [{ name: 'A', rows: [['a']] }], extraFiles: extra, contentTypesExtra: ct });

test('sniff: XLSX', () => assert.deepEqual(sniff(book()), { ok: true, kind: 'xlsx' }));

test('sniff: XLSM и vbaProject.bin → macro', () => {
  assert.deepEqual(sniff(book([{ name: 'xl/vbaProject.bin', data: 'x' }])), { ok: false, code: 'macro' });
  assert.deepEqual(sniff(book([], '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>')), { ok: false, code: 'macro' });
  assert.deepEqual(sniff(book([{ name: 'xl/activeX/activeX1.xml', data: 'x' }])), { ok: false, code: 'macro' });
});

test('sniff: DOCX, ODS, XLSB и «и то и другое» → bad_type', () => {
  const docx = zip([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: 'word/document.xml', data: '<w/>' },
  ]);
  assert.deepEqual(sniff(docx), { ok: false, code: 'bad_type' });
  const ods = zip([
    { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', method: 0 },
    { name: '[Content_Types].xml', data: '<Types/>' },
  ]);
  assert.deepEqual(sniff(ods), { ok: false, code: 'bad_type' });
  assert.deepEqual(sniff(book([{ name: 'xl/workbook.bin', data: 'x' }])), { ok: false, code: 'bad_type' });
  assert.deepEqual(sniff(book([{ name: 'word/document.xml', data: '<w/>' }])), { ok: false, code: 'bad_type' });
});

test('sniff: OLE2 → legacy_xls', () => {
  assert.deepEqual(sniff(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0)), { ok: false, code: 'legacy_xls' });
});

test('sniff: PDF, PNG, JPEG, GIF, RIFF и NUL → bad_type; пустой → empty', () => {
  for (const head of ['%PDF-1.7 abc', '\x89PNG\r\n', '\xff\xd8\xff\xe0', 'GIF89a', 'RIFF1234']) {
    assert.deepEqual(sniff(Buffer.from(head, 'latin1')), { ok: false, code: 'bad_type' }, head);
  }
  assert.deepEqual(sniff(Buffer.from('a;b\n1;\u0000;3\n')), { ok: false, code: 'bad_type' });
  assert.deepEqual(sniff(new Uint8Array(0)), { ok: false, code: 'empty' });
});

test('sniff: UTF-16 и UTF-32 BOM → unsupported_encoding', () => {
  assert.deepEqual(sniff(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a;b', 'utf16le')])), { ok: false, code: 'unsupported_encoding' });
  assert.deepEqual(sniff(Buffer.from([0xfe, 0xff, 0, 0x61])), { ok: false, code: 'unsupported_encoding' });
  assert.deepEqual(sniff(Buffer.from([0x00, 0x00, 0xfe, 0xff, 0, 0, 0, 0x61])), { ok: false, code: 'unsupported_encoding' });
  assert.deepEqual(sniff(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0, 0, 0])), { ok: false, code: 'unsupported_encoding' });
});

test('sniff: CSV UTF-8 с BOM и без, Windows-1251', () => {
  assert.deepEqual(sniff(Buffer.from('﻿Тип;Наименование\n')), { ok: true, kind: 'csv', encoding: 'utf-8' });
  assert.deepEqual(sniff(Buffer.from('Тип;Наименование\n')), { ok: true, kind: 'csv', encoding: 'utf-8' });
  assert.deepEqual(sniff(Buffer.from([0xd2, 0xe8, 0xef, 0x3b, 0xcd, 0xe0, 0xe8, 0xec, 0x0a])), { ok: true, kind: 'csv', encoding: 'windows-1251' });
});

test('sniff: расширение и Content-Type не учитываются (сигнатура решает всё)', () => {
  // XLSX-контейнер остаётся XLSX, а текст с «PK» не в начале — CSV
  assert.equal(sniff(book()).ok, true);
  assert.deepEqual(sniff(Buffer.from('xPK\u0003\u0004')), { ok: true, kind: 'csv', encoding: 'utf-8' });
});
