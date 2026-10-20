// Белый список путей настроек продаж (R2b): схемы тела и перекрёстные проверки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossIssues, HolidaysInput, patchPaths, SALES_PATHS, SalesPatchInput } from '../../../src/server/domain/admin/salesSettingsPaths';

const rev = { global: 1, space: 1 };
const ok = (patch: unknown) => SalesPatchInput.safeParse({ expectedRev: rev, patch }).success;

test('белый список: ровно пути D-267, праздников среди них нет', () => {
  assert.deepEqual(
    SALES_PATHS.map((p) => p.path),
    ['distribution.dailyCap', 'distribution.schedule.from', 'distribution.schedule.to', 'distribution.schedule.everyMin', 'calendar.callWindow.start', 'calendar.callWindow.end', 'reports.callsPerHourTarget'],
  );
});

test('патч: допустимые значения', () => {
  assert.ok(ok({ dailyCap: 0 }));
  assert.ok(ok({ dailyCap: 500 }));
  assert.ok(ok({ schedule: { from: '09:00', everyMin: 15 } }));
  assert.ok(ok({ callWindow: { end: '19:30' } }));
  assert.ok(ok({ callsPerHourTarget: null }));
  assert.ok(ok({ callsPerHourTarget: 100 }));
});

test('патч: неверные значения отклоняются', () => {
  assert.equal(ok({ dailyCap: 501 }), false);
  assert.equal(ok({ dailyCap: -1 }), false);
  assert.equal(ok({ dailyCap: 1.5 }), false);
  assert.equal(ok({ dailyCap: '40' }), false);
  assert.equal(ok({ schedule: { everyMin: 45 } }), false);
  assert.equal(ok({ schedule: { from: '9:00' } }), false);
  assert.equal(ok({ schedule: { to: '24:00' } }), false);
  assert.equal(ok({ callWindow: { start: '09:60' } }), false);
  assert.equal(ok({ callsPerHourTarget: 0 }), false);
  assert.equal(ok({ callsPerHourTarget: 101 }), false);
});

test('патч: любой ключ вне списка — отказ (.strict)', () => {
  assert.equal(ok({ capOverride: true }), false);
  assert.equal(ok({ mode: 'off' }), false);
  assert.equal(ok({ roles: [] }), false);
  assert.equal(ok({ schedule: { workdaysOnly: false } }), false);
  assert.equal(ok({ callWindow: { start: '09:00', tz: 'UTC' } }), false);
  assert.equal(ok({ holidays: [] }), false);
  assert.equal(SalesPatchInput.safeParse({ expectedRev: rev, patch: {}, extra: 1 }).success, false);
  assert.equal(SalesPatchInput.safeParse({ patch: { dailyCap: 1 } }).success, false, 'без expectedRev');
  assert.equal(SalesPatchInput.safeParse({ expectedRev: { global: 1 }, patch: { dailyCap: 1 } }).success, false, 'ревизия пространства обязательна');
});

test('patchPaths: пути для note', () => {
  assert.deepEqual(patchPaths({}), []);
  assert.deepEqual(patchPaths({ dailyCap: 5, schedule: { to: '18:00' }, callsPerHourTarget: null }), ['distribution.dailyCap', 'distribution.schedule.to', 'reports.callsPerHourTarget']);
});

test('crossIssues: from < to и start < end по итоговым значениям', () => {
  const next = { from: '10:00', to: '10:00', start: '09:00', end: '18:00' };
  assert.deepEqual(crossIssues(next, { schedule: { from: '10:00' } }), [{ path: 'schedule.to' }]);
  assert.deepEqual(crossIssues(next, { dailyCap: 3 }), [], 'неизменённый путь не проверяется');
  assert.deepEqual(crossIssues({ ...next, to: '18:00', start: '19:00' }, { callWindow: { start: '19:00' } }), [{ path: 'callWindow.end' }]);
});

const hol = (date: string, kind = 'holiday', note = '') => ({ date, kind, note });
const okH = (holidays: unknown) => HolidaysInput.safeParse({ expectedRev: { global: 1 }, holidays }).success;

test('праздники: формат, дата, уникальность, заметка, лимит', () => {
  assert.ok(okH([]));
  assert.ok(okH([hol('2026-12-31'), hol('2027-01-02', 'workday', 'Перенос')]));
  assert.equal(okH([hol('2026-02-30')]), false, 'несуществующая дата');
  assert.equal(okH([hol('31.12.2026')]), false);
  assert.equal(okH([hol('2026-12-31'), hol('2026-12-31', 'workday')]), false, 'дата повторяется');
  assert.equal(okH([hol('2026-12-31', 'holiday', 'я'.repeat(101))]), false);
  assert.ok(okH([hol('2026-12-31', 'holiday', 'я'.repeat(100))]));
  assert.equal(okH([hol('2026-12-31', 'bad')]), false);
  assert.equal(okH([{ date: '2026-12-31', kind: 'holiday', note: '', x: 1 }]), false);
  const many = Array.from({ length: 301 }, (_, i) => hol(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)));
  assert.equal(okH(many), false);
  assert.ok(okH(many.slice(0, 300)));
});
