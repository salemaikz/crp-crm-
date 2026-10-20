// Местное время без библиотек и быстрые сроки перезвона.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWorkday, resolvePreset } from '../../../src/ui/call/callback';
import type { CallCalendar } from '../../../src/ui/call/types';
import { addDays, fromInputValue, fromLocal, isoWeekday, localDay, partsOf, toInputValue } from '../../../src/ui/call/zoned';

const TZ = 'Asia/Almaty';
// Среда 28.10.2026 11:00 по Алматы (UTC+5)
const NOW = Date.UTC(2026, 9, 28, 6, 0);
const CAL: CallCalendar = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-10-29', kind: 'holiday' }] };

test('местные сутки и части времени в поясе установки', () => {
  assert.equal(localDay(NOW, TZ), '2026-10-28');
  assert.deepEqual(partsOf(NOW, TZ), { y: 2026, m: 10, d: 28, h: 11, mi: 0 });
  // 22:30 UTC — уже следующие сутки в Алматы
  assert.equal(localDay(Date.UTC(2026, 9, 28, 22, 30), TZ), '2026-10-29');
});

test('fromLocal — обратное к partsOf; вход datetime-local туда и обратно', () => {
  assert.equal(fromLocal('2026-10-28', '11:00', TZ), NOW);
  assert.equal(toInputValue(NOW, TZ), '2026-10-28T11:00');
  assert.equal(fromInputValue('2026-10-28T11:00', TZ), NOW);
  assert.equal(fromInputValue('мусор', TZ), null);
});

test('день недели и сдвиг дней', () => {
  assert.equal(isoWeekday('2026-10-28'), 3);
  assert.equal(isoWeekday('2026-11-01'), 7);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('следующий рабочий день пропускает праздник и выходные', () => {
  assert.equal(nextWorkday('2026-10-28', CAL), '2026-10-30');
  assert.equal(nextWorkday('2026-10-30', CAL), '2026-11-02');
  // день, помеченный рабочим, работает даже в субботу
  assert.equal(nextWorkday('2026-10-30', { ...CAL, holidays: [{ date: '2026-10-31', kind: 'workday' }] }), '2026-10-31');
});

test('шаги перезвона: «+2 ч» от текущего момента, «следующий рабочий день 10:00» по календарю', () => {
  const plus = resolvePreset({ kind: 'plus', minutes: 120 }, NOW, TZ, CAL);
  assert.equal(plus.at, NOW + 2 * 3_600_000);
  assert.equal(plus.shape, 'plus');
  const next = resolvePreset({ kind: 'nextWorkday', time: '10:00' }, NOW, TZ, CAL);
  assert.equal(next.at, fromLocal('2026-10-30', '10:00', TZ));
  assert.equal(next.shape, 'day', '29.10 праздник — не «завтра»');
  const tomorrow = resolvePreset({ kind: 'nextWorkday', time: '10:00' }, Date.UTC(2026, 9, 26, 6, 0), TZ, CAL);
  assert.equal(tomorrow.shape, 'tomorrow');
});
