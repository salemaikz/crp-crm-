// Слияние слоёв `calendar.holidays` по `date` (CONFIG §3.1) и проверка строк.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkCalendar, mergeHolidays, validateHoliday } from '../../../packages/core/src/time';
import type { CalendarHoliday } from '../../../packages/core/src/time';
import { kzSettings, loadKzPreset } from './_kz';

const kzRows = loadKzPreset().global.calendar.holidays;

test('mergeHolidays: поздний слой перекрывает дату целиком, остальные даты слоя kz живы', () => {
  const client: CalendarHoliday[] = [
    { date: '2026-10-26', kind: 'workday', note: 'клиент работает' },
    { date: '2026-11-13', kind: 'holiday', note: 'корпоративный выходной' },
  ];
  const merged = mergeHolidays(kzRows, client);
  const byDate = new Map(merged.map((h) => [h.date, h]));
  assert.deepEqual(byDate.get('2026-10-26'), { date: '2026-10-26', kind: 'workday', note: 'клиент работает' });
  assert.deepEqual(byDate.get('2026-11-13'), { date: '2026-11-13', kind: 'holiday', note: 'корпоративный выходной' });
  assert.equal(byDate.get('2026-07-06')?.kind, 'holiday');
  assert.equal(merged.length, new Set(kzRows.map((h) => h.date).concat(['2026-11-13'])).size);
});

test('mergeHolidays: порядок результата — по дате; повтор внутри слоя — выигрывает последний', () => {
  const merged = mergeHolidays([
    { date: '2027-02-02', kind: 'holiday', note: 'б' },
    { date: '2027-01-01', kind: 'holiday' },
    { date: '2027-02-02', kind: 'workday', note: 'в' },
  ]);
  assert.deepEqual(merged, [
    { date: '2027-01-01', kind: 'holiday' },
    { date: '2027-02-02', kind: 'workday', note: 'в' },
  ]);
});

test('mergeHolidays не меняет входные слои', () => {
  const layer: CalendarHoliday[] = [{ date: '2026-11-13', kind: 'holiday', note: 'x' }];
  const before = structuredClone(layer);
  mergeHolidays(layer, [{ date: '2026-11-13', kind: 'workday' }]);
  assert.deepEqual(layer, before);
});

test('обновление слоя kz не затирает корпоративный выходной клиента', () => {
  // старая редакция слоя без 26.10; клиент добавил свой выходной 13.11
  const kzOld = kzRows.filter((h) => h.date !== '2026-10-26');
  const client: CalendarHoliday[] = [{ date: '2026-11-13', kind: 'holiday', note: 'корпоратив' }];
  const before = createWorkCalendar({ ...kzSettings(), holidays: mergeHolidays(kzOld, client) });
  const after = createWorkCalendar({ ...kzSettings(), holidays: mergeHolidays(kzRows, client) });
  assert.equal(before.isWorkday('2026-10-26'), true); // в старой редакции переноса ещё нет
  assert.equal(after.isWorkday('2026-10-26'), false); // новая редакция слоя kz его добавила
  assert.equal(before.isWorkday('2026-11-13'), false);
  assert.equal(after.isWorkday('2026-11-13'), false); // выходной клиента пережил обновление
});

test('validateHoliday: дата, вид и примечание проверяются', () => {
  assert.deepEqual(validateHoliday({ date: '2026-10-26', kind: 'holiday' }), { date: '2026-10-26', kind: 'holiday' });
  assert.throws(() => validateHoliday({ date: '2026-10-32', kind: 'holiday' }), RangeError);
  assert.throws(() => validateHoliday({ date: '26.10.2026', kind: 'holiday' }), RangeError);
  assert.throws(() => validateHoliday({ date: '2026-10-26', kind: 'off' as 'holiday' }), RangeError);
  assert.throws(() => validateHoliday({ date: '2026-10-26', kind: 'holiday', note: 5 as unknown as string }), RangeError);
});
