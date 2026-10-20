// Окно консультанта и местная дата (PROCESS §8.4): чистые расчёты ядра.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, consultantWindowDates, isValidTimeZone, localDay } from '../../../packages/core/src/access';

test('окно {-1, 30}: запись завтра и запись 30 дней назад видны, 31 день назад и послезавтра — нет', () => {
  const w = consultantWindowDates('2026-10-28', { fromDays: -1, toDays: 30 });
  assert.deepEqual(w, { from: '2026-09-28', to: '2026-10-29' });
  const inWin = (d: string) => d >= w.from && d <= w.to;
  assert.ok(inWin('2026-10-29')); // завтра — с 00:00 дня перед встречей
  assert.ok(!inWin('2026-10-30')); // послезавтра — ещё нет
  assert.ok(inWin('2026-09-28')); // 30-й день после встречи
  assert.ok(!inWin('2026-09-27')); // 31-й — уже нет
});

test('addDays: через границы месяца и года, високосный февраль', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.throws(() => addDays('28.10.2026', 1));
});

test('localDay: дата в поясе установки, а не UTC', () => {
  const t = Date.UTC(2026, 9, 27, 20, 30); // 27.10 20:30 UTC = 28.10 01:30 в UTC+5
  assert.equal(localDay(t, 'UTC'), '2026-10-27');
  assert.equal(localDay(t, 'Asia/Almaty'), '2026-10-28');
  assert.ok(isValidTimeZone('Asia/Almaty'));
  assert.ok(!isValidTimeZone('Mars/Base'));
});
