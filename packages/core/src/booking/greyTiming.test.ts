/**
 * Расписание прогонов автоназначения «серых» заявок (booking.grey.schedule) и подсказка оператору.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { greyRunTimes, greyTiming, nextGreyRunAt } from './greyTiming';
import { localToEpoch } from './time';
import { TZ } from './fixtures';

const schedule = { first: '09:00', last: '18:00', stepMin: 30 };
const T = (date: string, time: string) => localToEpoch(TZ, date, time);

test('прогоны: 09:00, затем каждые 30 минут до 18:00 включительно — 19 запусков', () => {
  const times = greyRunTimes(schedule);
  assert.equal(times.length, 19);
  assert.deepEqual([times[0], times[1], times[2], times[18]], ['09:00', '09:30', '10:00', '18:00']);
});

test('расписание — из настроек: другие first/last/step дают другой ряд', () => {
  assert.deepEqual(greyRunTimes({ first: '10:00', last: '12:00', stepMin: 60 }), ['10:00', '11:00', '12:00']);
  assert.deepEqual(greyRunTimes({ first: '10:00', last: '11:30', stepMin: 45 }), ['10:00', '10:45', '11:30']);
  assert.deepEqual(greyRunTimes({ first: '10:00', last: '09:00', stepMin: 30 }), ['10:00'], 'last раньше first — один прогон');
  assert.deepEqual(greyRunTimes({ first: '10:00', last: '12:00', stepMin: 0 }), ['10:00'], 'нулевой шаг не зацикливает');
});

test('день позже сегодняшнего и сегодня до первого прогона — «первый прогон»', () => {
  assert.equal(greyTiming('2026-10-23', T('2026-10-22', '14:00'), schedule, TZ), 'first_run');
  assert.equal(greyTiming('2026-10-22', T('2026-10-22', '08:59'), schedule, TZ), 'first_run');
});

test('сегодня между первым и последним прогоном — ближайший шаговый', () => {
  assert.equal(greyTiming('2026-10-22', T('2026-10-22', '09:00'), schedule, TZ), 'next_run');
  assert.equal(greyTiming('2026-10-22', T('2026-10-22', '17:59'), schedule, TZ), 'next_run');
});

test('сегодня с последнего прогона и прошедший день — только вручную', () => {
  assert.equal(greyTiming('2026-10-22', T('2026-10-22', '18:00'), schedule, TZ), 'too_late');
  assert.equal(greyTiming('2026-10-22', T('2026-10-22', '21:00'), schedule, TZ), 'too_late');
  assert.equal(greyTiming('2026-10-21', T('2026-10-22', '10:00'), schedule, TZ), 'too_late');
});

test('«сегодня» считается по поясу настроек: в 23:30 UTC в Алматы уже следующий день', () => {
  const now = Date.parse('2026-10-20T23:30:00.000Z'); // 21.10 04:30 по Алматы
  assert.equal(greyTiming('2026-10-21', now, schedule, TZ), 'first_run');
  assert.equal(greyTiming('2026-10-21', now, schedule, 'UTC'), 'first_run', 'для UTC 21.10 — завтра, тоже первый прогон');
  assert.equal(greyTiming('2026-10-20', now, schedule, TZ), 'too_late', '20.10 по Алматы — уже вчера');
  assert.equal(greyTiming('2026-10-20', now, schedule, 'UTC'), 'too_late', 'для UTC 20.10 23:30 — после последнего прогона');
});

test('следующий прогон сегодня или null после последнего', () => {
  assert.equal(nextGreyRunAt(T('2026-10-22', '09:10'), schedule, TZ), T('2026-10-22', '09:30'));
  assert.equal(nextGreyRunAt(T('2026-10-22', '09:30'), schedule, TZ), T('2026-10-22', '10:00'), 'строго после now');
  assert.equal(nextGreyRunAt(T('2026-10-22', '07:00'), schedule, TZ), T('2026-10-22', '09:00'));
  assert.equal(nextGreyRunAt(T('2026-10-22', '18:00'), schedule, TZ), null);
});
