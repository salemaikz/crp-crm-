// Стык XLSX-ридера и разбора «Записей» (D-324): ячейки «Время» в формате времени и «Дата» с временем, как их
// сохраняет Excel, не уходят в ошибки разбора. Только синтетика.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imports } from '@crm/core';
import { limitsFor, readSpreadsheet } from '../../../src/server/platform/files';
import { serialToText } from '../../../src/server/platform/files/xlsx/dates';
import { xlsx } from './xlsxBuilder';

// 46336 = 2026-11-10 (эпоха 1900); в эпохе 1904 тот же день — 46336 − 1462
const NOV10 = 46336;

test('serialToText: время без даты — день эпохи + ЧЧ:ММ, полночь — только день; дата со временем', () => {
  assert.equal(serialToText('0.5', false), '1899-12-30 12:00');
  assert.equal(serialToText('0.75', true), '1904-01-01 18:00');
  assert.equal(serialToText('0', false), '1899-12-30');
  assert.equal(serialToText(String(NOV10 + 0.5), false), '2026-11-10 12:00');
  // разбор «Записей» понимает ровно эти выходы
  assert.equal(imports.parseEventTime(serialToText('0.5', false) as string), '12:00');
  assert.equal(imports.parseEventTime(serialToText('0.75', true) as string), '18:00');
  assert.equal(imports.parseEventTime(serialToText('0', false) as string), '00:00');
  assert.equal(imports.parseEventDate(serialToText(String(NOV10 + 0.5), false) as string), '2026-11-10');
});

test('XLSX со стилями h:mm и dd.mm.yyyy hh:mm → строки «Записей» без bad_time и bad_date', async () => {
  const head = ['Наименование', 'Телефон', 'Дата', 'Время', 'Оператор'];
  const book = xlsx({
    sheets: [
      {
        name: 'Записи',
        rows: [head, ['ТОО «Альфа Синтетик»', '+7 709 111 22 33', { date: NOV10 }, { time: 0.5 }, 'Оператор-01'], ['ТОО «Бета Синтетик»', '+7 709 111 22 44', { dateTime: NOV10 + 0.75 }, null, 'Оператор-02']],
      },
    ],
  });
  const r = await readSpreadsheet(book, { limits: limitsFor({ maxFileMb: 10, maxRows: 1000 }) });
  const cp = imports.compileBookingProfile({ key: 'b', columns: { Наименование: 'name', Телефон: 'phones', Дата: 'eventDate', Время: 'eventTime', Оператор: 'operator' }, eventTypeMap: {}, defaultEventTypeKey: 'grp' });
  const normalizers = (await import('../../../packages/core/src/import/testProfile')).normalizers;
  const parsed = imports.parseBookingSheet(r.grid, cp, { normalizers, hash: (s) => s, hmac: (s) => s });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(
    parsed.rows.map((x) => [x.eventDate, x.eventTime, x.issues.map((i) => i.code)]),
    [
      ['2026-11-10', '12:00', []],
      ['2026-11-10', '18:00', []],
    ],
  );
});
