/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД читаются по путям */
// XLSX через сервис: общие строки, дата снимка, выбор листа, номер телефона без потери цифр, ИИН только HMAC.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ImportError, importService } from '../../../src/server/domain/import';
import { overrideImportContextForTests } from '../../../src/server/domain/import/settings';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { SpreadsheetError } from '../../../src/server/platform/files';
import { xlsx } from '../../unit/import/xlsxBuilder';
import { T0, makeWorld, upload, type World } from './helpers';

let db: TestDb;
let w: World;
before(async () => {
  db = await createTestDb();
  w = await makeWorld(db, 50, 3);
});
after(async () => {
  overrideImportContextForTests(null);
  await db.close();
});

const HEAD = ['Тип', 'Наименование', 'Регион', 'Руководитель', 'ОКЭД', 'Телефон', 'Адрес', 'ИИН', 'ЛПР подтвержден', 'Ответ', 'Статус', 'Точная ниша', 'Заметка'];
const row = (name: string, phone: string | number, extra: Partial<Record<string, string>> = {}) =>
  HEAD.map((h) => (h === 'Тип' ? (extra.Тип ?? 'ТОО') : h === 'Наименование' ? name : h === 'Телефон' ? phone : (extra[h] ?? '')));

test('xlsx: загрузка книги с двумя листами — нужен выбор листа; предпросмотр и применение', async () => {
  const book = xlsx({
    sheets: [
      { name: 'Основная', rows: [['Журнал первого касания'], HEAD, row('ТОО «Альфа Синтетик»', '+7 709 111 22 33'), row('ИП Бета Синтетик', 77091112244, { Тип: 'ИП', ИИН: '990101300999' }), row('ТОО «Гамма Синтетик»', '+7 709 111 22 55', { Ответ: 'Перезвонить' })] },
      { name: 'Обработанные', rows: [['x']] },
    ],
  });
  await assert.rejects(upload(w.lead, book), (e: unknown) => e instanceof SpreadsheetError && e.code === 'sheet_required' && e.sheets?.length === 2);
  await assert.rejects(upload(w.lead, book, { sheet: 'Нет' }), (e: unknown) => e instanceof SpreadsheetError && e.code === 'sheet_not_found');
  const up = await upload(w.lead, book, { sheet: 'Основная' });
  assert.equal(up.kind, 'xlsx');
  assert.deepEqual(up.sheets, ['Основная', 'Обработанные']);
  assert.equal(up.headerRow, 2);
  assert.equal(up.rows, 3);
  const [{ n }] = await db.sql<any>`SELECT count(*)::int AS n FROM import_rows WHERE import_id = ${up.importId} AND parsed::text ~ '990101300999'`;
  assert.equal(n, 0, 'ИИН не лежит в строках');
  const [ip] = await db.sql<any>`SELECT parsed FROM import_rows WHERE import_id = ${up.importId} AND row_no = 4`;
  assert.deepEqual(ip.parsed.workingPhones, ['77091112244'], 'число 77091112244 без потери цифр');
  assert.match(ip.parsed.orgId, /^iin:[0-9a-f]{64}$/);
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, T0);
  assert.equal(s.counts.byAction.create, 3);
  assert.equal(s.counts.held.rule, 1, 'ИП на разбор юриста');
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, T0 + 1);
  assert.equal(r.written.clientsCreated, 3);
  const ips = await db.sql<any>`SELECT org_id, iin_hmac FROM clients WHERE iin_hmac IS NOT NULL`;
  assert.equal(ips.length, 1);
  assert.equal(ips[0].orgId, '');
});

test('xlsx: заголовки не нашлись — header_not_found с перечнем колонок', async () => {
  const book = xlsx({ sheets: [{ name: 'A', rows: [['Что-то', 'Другое'], ['a', 'b']] }] });
  await assert.rejects(upload(w.lead, book), (e: unknown) => e instanceof ImportError && e.code === 'header_not_found' && (e.detail.missing ?? []).length > 0);
});
