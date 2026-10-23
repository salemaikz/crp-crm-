// Одно правило просрочки (pipeline-v2 §4.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueBounds, fireOf, isOverdue } from './due.js';
import { at, TEST_CALENDAR } from './spec/vectors.js';
import { createWorkCalendar } from '../time/index.js';

/** Настройки установки: Asia/Almaty, пн–пт, окно 09:00–18:00; 26.10.2026 — выходной (перенос). */
const kzSettings = () => ({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [{ date: '2026-10-26', kind: 'holiday' as const, note: 'перенос' }],
});

const day = (now: string, due: string, tol = 30) => isOverdue(at(due), 'day', dueBounds(at(now), tol, TEST_CALENDAR));
const time = (now: string, due: string, tol = 30) => isOverdue(at(due), 'time', dueBounds(at(now), tol, TEST_CALENDAR));

test('границы: начало сегодняшних и завтрашних суток, порог по времени', () => {
  const b = dueBounds(at('2026-10-30 17:59'), 30, TEST_CALENDAR);
  assert.equal(b.dayBefore, at('2026-10-30 00:00'));
  assert.equal(b.tomorrowStart, at('2026-10-31 00:00'));
  assert.equal(b.timeBefore, at('2026-10-30 17:29'));
});

test('«день»: пт 17:59 не просрочен; сб 10:00 и пн 09:00 просрочены (выходные не исключаются)', () => {
  const due = '2026-10-30 09:00';
  assert.equal(day('2026-10-30 17:59', due), false);
  assert.equal(day('2026-10-30 23:59', due), false);
  assert.equal(day('2026-10-31 00:00', due), true);
  assert.equal(day('2026-10-31 10:00', due), true);
  assert.equal(day('2026-11-02 09:00', due), true);
});

test('«время» 15:00 с порогом 30 мин: 15:29 нет, 15:30 да', () => {
  const due = '2026-10-30 15:00';
  assert.equal(time('2026-10-30 15:29', due), false);
  assert.equal(time('2026-10-30 15:30', due), true);
  assert.equal(time('2026-10-30 15:30', due, 0), true);
  assert.equal(time('2026-10-30 15:00', due, 0), true);
  assert.equal(time('2026-10-30 14:59', due, 0), false);
});

test('огонёк: просрочен / сегодня / позже / без срока', () => {
  const b = dueBounds(at('2026-10-30 12:00'), 30, TEST_CALENDAR);
  assert.equal(fireOf(null, 'time', b), null);
  assert.equal(fireOf(at('2026-10-30 09:00'), 'day', b), 'today');
  assert.equal(fireOf(at('2026-10-29 09:00'), 'day', b), 'overdue');
  assert.equal(fireOf(at('2026-10-30 11:00'), 'time', b), 'overdue');
  assert.equal(fireOf(at('2026-10-30 12:10'), 'time', b), 'today');
  assert.equal(fireOf(at('2026-10-31 09:00'), 'time', b), null);
});

test('настоящий календарь установки даёт те же границы', () => {
  const cal = createWorkCalendar(kzSettings());
  const b = dueBounds(at('2026-10-30 17:59'), 30, cal);
  assert.equal(b.dayBefore, at('2026-10-30 00:00'));
  assert.equal(b.tomorrowStart, at('2026-10-31 00:00'));
});
