// Корзины срока на границах местных суток и предупреждение о нерабочем сроке (PROCESS 6.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import { bucketOf, dayBounds, dueOutsideWork } from '../../../src/server/domain/tasks/buckets';

const TZ = 'Asia/Almaty';
const at = (day: string, hhmm: string) => time.fromLocalTime(day, hhmm, TZ);

test('границы суток — местные: 23:59 сегодня, 00:00 завтра, 00:00 послезавтра', () => {
  const now = at('2026-10-28', '11:00');
  const b = dayBounds(now, '2026-10-28', TZ);
  assert.equal(b.tomorrowStart, at('2026-10-29', '00:00'));
  assert.equal(bucketOf(now - 1, b), 'overdue');
  assert.equal(bucketOf(now, b), 'today');
  assert.equal(bucketOf(at('2026-10-28', '23:59'), b), 'today');
  assert.equal(bucketOf(at('2026-10-29', '00:00'), b), 'tomorrow');
  assert.equal(bucketOf(at('2026-10-29', '23:59'), b), 'tomorrow');
  assert.equal(bucketOf(at('2026-10-30', '00:00'), b), 'later');
  assert.equal(bucketOf(null, b), 'none');
});

test('поздно вечером «сегодня» — только до полуночи по поясу установки, а не по UTC', () => {
  // 23:30 по Алматы = 18:30 UTC: в UTC ещё те же сутки, но местная полночь уже через 30 минут
  const now = at('2026-10-28', '23:30');
  const b = dayBounds(now, '2026-10-28', TZ);
  assert.equal(bucketOf(at('2026-10-29', '00:10'), b), 'tomorrow');
  assert.equal(bucketOf(at('2026-10-28', '23:45'), b), 'today');
});

test('срок на выходной или вне рабочих часов — предупреждение, в рабочее время — нет', () => {
  const cal = time.createWorkCalendar({
    timezone: TZ,
    workdays: [1, 2, 3, 4, 5],
    workHours: { start: '09:00', end: '18:00' },
    callWindow: { start: '09:00', end: '18:00' },
    holidays: [],
  });
  // 30.10.2026 — пятница, 31.10 — суббота
  assert.equal(dueOutsideWork(at('2026-10-30', '17:00'), cal), false);
  assert.equal(dueOutsideWork(at('2026-10-31', '17:00'), cal), true);
  assert.equal(dueOutsideWork(at('2026-10-30', '19:00'), cal), true);
  assert.equal(dueOutsideWork(null, cal), false);
});
