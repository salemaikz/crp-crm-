// Чистая часть консультаций (B5b): сборка снимка дня, времена и варианты полосы подбора, решение о записи.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../../../packages/core/src';
import { buildDaySnapshot, decideConsultPlacement, parseExceptionWindows, stripOption, stripTimes } from '../../../src/server/domain/booking/consultDay';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { ResourceListRow } from '../../../src/server/domain/booking/repo';
import type { DayBookingRow, ExceptionRow, ScheduleRow } from '../../../src/server/domain/booking/repo.consult';
import type { BookingSettings } from '../../../src/server/domain/booking/types';

const CAL = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});
const SETTINGS = {
  timeZone: 'Asia/Almaty',
  calendar: CAL,
  horizonDays: 28,
  catalog: { eventTypes: [], directions: [], consult: { slotMinutes: 45, hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }, stripDays: 7 } },
} as unknown as BookingSettings;
const DAY = '2026-11-03'; // вторник

const res = (id: string, over: Partial<ResourceListRow> = {}): ResourceListRow => ({
  id,
  spaceId: 's',
  userId: `u-${id}`,
  directions: [],
  slotMin: 45,
  capacity: 1,
  autoAssign: true,
  active: true,
  sort: 0,
  createdAt: 0,
  updatedAt: 0,
  name: id.toUpperCase(),
  usesSchedule: false,
  ...over,
});
const sched = (resourceId: string, start: string, end: string): ScheduleRow => ({ resourceId, weekday: 2, startTime: start, endTime: end });
const bk = (id: string, resourceId: string | null, startTime: string, over: Partial<DayBookingRow> = {}): DayBookingRow => ({
  id,
  resourceId,
  startTime,
  durationMin: 45,
  isReserve: false,
  createdAt: 1,
  directionKey: 'marketing',
  ...over,
});
const snap = (resources: ResourceListRow[], schedule: ScheduleRow[] = [], bookings: DayBookingRow[] = [], exceptions: ExceptionRow[] = []) =>
  buildDaySnapshot({ date: DAY, settings: SETTINGS, resources, schedule, exceptions, bookings });

test('окна исключения: формат {start,end} и {from,to}; мусор и обратные окна отбрасываются', () => {
  assert.deepEqual(parseExceptionWindows([{ start: '10:00', end: '11:00' }, { from: '12:00', to: '13:00' }, { start: '14:00', end: '13:00' }, { start: 'xx', end: '15:00' }, null]), [
    { start: '10:00', end: '11:00' },
    { start: '12:00', end: '13:00' },
  ]);
  assert.deepEqual(parseExceptionWindows('нет'), []);
});

test('снимок: только активные консультанты; записи выключенных остаются в bookings (для конфликтов)', () => {
  const s = snap([res('a'), res('b', { active: false })], [], [bk('x', 'b', '10:00'), bk('g', null, '10:00')]);
  assert.deepEqual(s.consultants.map((c) => c.id), ['a']);
  assert.deepEqual(s.bookings.map((b) => [b.id, b.consultantId]), [['x', 'b'], ['g', null]]);
});

test('времена полосы: сетка часов плюс старты слотов графика (без дублей, по порядку)', () => {
  const s = snap([res('a'), res('b', { usesSchedule: true, slotMin: 60 })], [sched('b', '09:30', '12:30')]);
  const { all, grid } = stripTimes(s, SETTINGS);
  assert.deepEqual([...grid], ['09:00', '09:45', '10:30', '11:15']);
  // слоты b по 60 минут от 09:30: 09:30, 10:30, 11:30; сетка: 09:00, 09:45, 10:30, 11:15
  assert.deepEqual(all, ['09:00', '09:30', '09:45', '10:30', '11:15', '11:30']);
});

test('вариант полосы: лучший по направлению, остальные следом; «Назначим утром» — по сетке и пулу; консультант по отношению — только он', () => {
  const s = snap([res('a', { directions: ['marketing'] }), res('b')]);
  const grid = new Set(['09:00']);
  const opt = stripOption({ snap: s, time: '09:00', grid, durationMin: 45, directionKey: 'marketing', only: null })!;
  assert.deepEqual([opt.suggested?.resourceId, opt.others.map((o) => o.resourceId), opt.greyAllowed], ['a', ['b'], true]);
  const own = stripOption({ snap: s, time: '09:00', grid, durationMin: 45, directionKey: 'marketing', only: 'b' })!;
  assert.deepEqual([own.suggested?.resourceId, own.others, own.greyAllowed], ['b', [], false]);
  // времени нет в сетке и ранг пуст — варианта нет
  assert.equal(stripOption({ snap: snap([]), time: '09:00', grid, durationMin: 45, directionKey: 'marketing', only: null }), null);
});

test('вариант полосы: пул занят «серой» — места для новой «серой» нет, но консультанту записать можно, если не отнимает место', () => {
  const s = snap([res('a'), res('b', { autoAssign: false })], [], [bk('g', null, '09:00')]);
  const opt = stripOption({ snap: s, time: '09:00', grid: new Set(['09:00']), durationMin: 45, directionKey: 'marketing', only: null })!;
  assert.equal(opt.greyAllowed, false, 'a один, «серая» уже ждёт');
  assert.deepEqual([opt.suggested?.resourceId, opt.others.length], ['b', 0], 'a отнял бы место у «серой» — только b');
});

test('решение о записи: «серая» без места — pool_full; к консультанту — slot_taken (альтернативы из ранга); резерв и длительность слота', () => {
  const resources = [res('a', { usesSchedule: true, slotMin: 60, capacity: 2 }), res('b'), res('c'), res('d'), res('e')];
  const base = {
    settings: SETTINGS,
    ops: { grey: { schedule: { first: '09:00', last: '10:00', stepMin: 30 } } },
    type: { durationMin: 45 },
    directionKey: 'marketing',
    date: DAY,
    now: Date.UTC(2026, 10, 1),
    resources,
    excludeBookingId: null,
  };
  const s = snap(resources, [sched('a', '09:00', '12:00')], [bk('x', 'a', '09:00', { durationMin: 60 })]);
  const reserve = decideConsultPlacement({ ...base, snapshot: s, time: '09:00', resourceId: 'a' });
  assert.deepEqual([reserve.resourceId, reserve.isReserve, reserve.durationMin], ['a', true, 60]);
  const grey = decideConsultPlacement({ ...base, snapshot: s, time: '09:00', resourceId: null });
  assert.deepEqual([grey.resourceId, grey.durationMin, grey.greyTooLate], [null, 45, false]);
  // все заняты → slot_taken у b и pool_full для «серой»
  const busy = snap(resources, [sched('a', '09:00', '12:00')], ['b', 'c', 'd', 'e'].map((id) => bk(`b-${id}`, id, '09:45')).concat(bk('xa', 'a', '09:00', { durationMin: 60 }), bk('xa2', 'a', '09:00', { durationMin: 60, isReserve: true })));
  assert.throws(() => decideConsultPlacement({ ...base, snapshot: busy, time: '09:45', resourceId: null }), (e: unknown) => e instanceof BookingDomainError && e.code === 'pool_full');
  assert.throws(
    () => decideConsultPlacement({ ...base, snapshot: busy, time: '09:45', resourceId: 'b' }),
    (e: unknown) => e instanceof BookingDomainError && e.code === 'slot_taken' && (e.suggestions ?? []).length === 0,
  );
  // переносимая запись освобождает место
  const moved = decideConsultPlacement({ ...base, snapshot: busy, time: '09:45', resourceId: 'b', excludeBookingId: 'b-b' });
  assert.equal(moved.resourceId, 'b');
  assert.throws(() => decideConsultPlacement({ ...base, snapshot: s, time: '09:00', resourceId: 'нет' }), (e: unknown) => e instanceof BookingDomainError && e.code === 'consultant_not_found');
});
