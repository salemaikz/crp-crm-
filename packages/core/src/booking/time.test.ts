/**
 * Местное время записей с поясом из настроек. Тесты гоняются при TZ=UTC и TZ=Asia/Almaty:
 * результат от пояса процесса зависеть не должен.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays, epochToLocalDate, epochToLocalTime, isLocalDate, isLocalTime, isoWeekday, isValidTimezone,
  localDayStart, localToEpoch, minToTime, nextWeekday, timeToMin, tzOffsetMs, weekStart,
} from './time';
import { TZ } from './fixtures';

const MIN_MS = 60_000;

test('четверг 15:00 по Алматы — это 10:00 UTC, туда и обратно без дрейфа', () => {
  const ms = localToEpoch(TZ, '2026-10-22', '15:00');
  assert.equal(new Date(ms).toISOString(), '2026-10-22T10:00:00.000Z');
  assert.equal(epochToLocalDate(TZ, ms), '2026-10-22');
  assert.equal(epochToLocalTime(TZ, ms), '15:00');
});

test('полночь по Алматы — ещё вчера по UTC, но местная дата — сегодня', () => {
  const ms = localToEpoch(TZ, '2026-10-22', '00:30');
  assert.equal(new Date(ms).toISOString(), '2026-10-21T19:30:00.000Z');
  assert.equal(epochToLocalDate(TZ, ms), '2026-10-22');
  assert.equal(localDayStart(TZ, '2026-10-22'), Date.parse('2026-10-21T19:00:00.000Z'));
});

test('Алматы — фиксированный UTC+5 (с 2024 года), UTC — ноль', () => {
  assert.equal(tzOffsetMs('Asia/Almaty', Date.parse('2026-10-22T00:00:00Z')), 5 * 60 * MIN_MS);
  assert.equal(tzOffsetMs('Asia/Almaty', Date.parse('2026-01-15T00:00:00Z')), 5 * 60 * MIN_MS);
  assert.equal(tzOffsetMs('UTC', Date.parse('2026-10-22T00:00:00Z')), 0);
});

test('пояс с переходом на летнее время: смещение берётся в нужный момент', () => {
  // Берлин: зимой UTC+1, летом UTC+2. 15:00 местного — разные моменты UTC.
  assert.equal(new Date(localToEpoch('Europe/Berlin', '2026-01-15', '15:00')).toISOString(), '2026-01-15T14:00:00.000Z');
  assert.equal(new Date(localToEpoch('Europe/Berlin', '2026-07-15', '15:00')).toISOString(), '2026-07-15T13:00:00.000Z');
  const ms = localToEpoch('Europe/Berlin', '2026-07-15', '15:00');
  assert.equal(epochToLocalTime('Europe/Berlin', ms), '15:00');
});

test('пояс — параметр: тот же момент в разных поясах даёт разную местную дату', () => {
  const ms = Date.parse('2026-10-20T23:30:00.000Z');
  assert.equal(epochToLocalDate('UTC', ms), '2026-10-20');
  assert.equal(epochToLocalDate('Asia/Almaty', ms), '2026-10-21');
});

test('isValidTimezone отличает IANA-имя от мусора', () => {
  assert.equal(isValidTimezone('Asia/Almaty'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
});

test('несуществующие даты и время отвергаются', () => {
  assert.equal(isLocalDate('2026-02-30'), false);
  assert.equal(isLocalDate('2026-13-01'), false);
  assert.equal(isLocalDate('22.10.2026'), false);
  assert.equal(isLocalDate('2026-10-22'), true);
  assert.equal(isLocalTime('24:00'), false);
  assert.equal(isLocalTime('9:00'), false);
  assert.equal(isLocalTime('09:00'), true);
  assert.throws(() => addDays('2026-02-30', 1), RangeError);
});

test('минуты суток и обратно', () => {
  assert.equal(timeToMin('15:30'), 930);
  assert.equal(minToTime(930), '15:30');
  assert.equal(minToTime(5), '00:05');
});

test('день недели, понедельник недели и ближайший четверг', () => {
  assert.equal(isoWeekday('2026-10-22'), 4, '22.10.2026 — четверг');
  assert.equal(isoWeekday('2026-10-25'), 7, 'воскресенье — 7, а не 0');
  assert.equal(weekStart('2026-10-22'), '2026-10-19');
  assert.equal(weekStart('2026-10-25'), '2026-10-19', 'воскресенье — конец той же недели');
  assert.equal(nextWeekday('2026-10-19', 4), '2026-10-22');
  assert.equal(nextWeekday('2026-10-22', 4), '2026-10-22', 'сегодня четверг — сегодня и есть ближайший');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('годы вне 2000–2100 допустимы, поясная арифметика — из общего календаря ядра', () => {
  assert.equal(isLocalDate('1999-12-31'), true);
  assert.equal(isLocalDate('2101-01-01'), true);
  assert.equal(isLocalDate('2100-02-29'), false, '2100 не високосный');
  assert.equal(addDays('2100-12-31', 1), '2101-01-01');
});
