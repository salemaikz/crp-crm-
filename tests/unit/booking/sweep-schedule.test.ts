// Расписание attendance-sweep: час из booking.attendance.sweepAt, умолчание 10:00 (D-243).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendanceSweepSchedule } from '../../../src/server/domain/booking/jobs';

const at = (attendance: object) => attendanceSweepSchedule({ global: {} as never, space: { booking: { attendance } } as never });

test('sweepAt из настроек пространства', () => {
  assert.deepEqual(at({ autoNoShowWorkdays: 2, sweepAt: '11:30' }), { kind: 'daily', at: '11:30', days: 'workdays' });
});

test('sweepAt не задан или документа нет — 10:00', () => {
  assert.deepEqual(at({ autoNoShowWorkdays: 2 }), { kind: 'daily', at: '10:00', days: 'workdays' });
  assert.deepEqual(attendanceSweepSchedule({ global: {} as never, space: null }), { kind: 'daily', at: '10:00', days: 'workdays' });
});
