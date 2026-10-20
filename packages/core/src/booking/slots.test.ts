/**
 * Движок слотов консультаций и снимок дня.
 *
 * Правило: к консультанту с графиком записать можно ТОЛЬКО в его слоты. Сервер проверяет попадание
 * по этим функциям: ошибка в них — либо запись в обход графика, либо «слотов нет», когда они есть.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSlots, countOverlapping, defaultHoursDay, effectiveDay, fitsPlan, intervalsToWindows, mergeRanges, slotStarts, workWindows,
} from './slots';
import { describeDay, orphanedBookings, poolRoom, reserveToPromote, starvedGreyBooking } from './daySnapshot';
import { minToTime } from './time';
import type { ScheduleException, ScheduleWindow } from './types';
import { MONDAY, THURSDAY, booking, consultant, snapshot } from './fixtures';

const week: ScheduleWindow[] = [
  { weekday: 1, start: '11:00', end: '13:00' },
  // четверг: окна 10:00–12:00 и 12:30–14:00, перерыв — промежуток между ними
  { weekday: 4, start: '10:00', end: '12:00' },
  { weekday: 4, start: '12:30', end: '14:00' },
];

const exc = (p: Partial<ScheduleException>): ScheduleException => ({ day: THURSDAY, kind: 'custom', windows: [], ...p });

test('недельный график: понедельник 11–13 режется на слоты по 45 минут встык', () => {
  const plan = effectiveDay(MONDAY, week, []);
  assert.deepEqual(slotStarts(plan, 45).map(minToTime), ['11:00', '11:45']);
});

test('перерыв — промежуток между окнами: слот не может накрыть обед', () => {
  const plan = effectiveDay(THURSDAY, week, []);
  assert.deepEqual(workWindows(plan), [[600, 720], [750, 840]]);
  // До обеда: 10:00, 10:45; 11:30 до 12:00 не влезает. После: 12:30, 13:15 (кончается ровно в 14:00).
  assert.deepEqual(slotStarts(plan, 45).map(minToTime), ['10:00', '10:45', '12:30', '13:15']);
});

test('нерабочий день и день без окон — слотов нет', () => {
  assert.equal(effectiveDay('2026-10-23', week, []).working, false, 'пятницы в графике нет');
  assert.equal(effectiveDay('2026-10-20', week, []).working, false, 'вторника в графике нет');
});

test('особые часы на дату побеждают недельный график', () => {
  const plan = effectiveDay(THURSDAY, week, [exc({ windows: [{ start: '15:00', end: '16:30' }] })]);
  assert.deepEqual(slotStarts(plan, 45).map(minToTime), ['15:00', '15:45']);
});

test('выходной/отпуск на дату гасит рабочий день, исключение другой даты не мешает', () => {
  assert.equal(effectiveDay(THURSDAY, week, [exc({ kind: 'off' })]).working, false);
  assert.equal(effectiveDay(THURSDAY, week, [exc({ kind: 'off', day: '2026-10-21' })]).working, true);
});

test('custom без окон — нерабочий день, как выходной', () => {
  assert.equal(effectiveDay(THURSDAY, week, [exc({ windows: [] })]).working, false);
  assert.equal(effectiveDay(THURSDAY, week, [exc({ windows: [{ start: '12:00', end: '11:00' }] })]).working, false);
});

test('пересекающиеся окна дня сливаются, порядок ввода не важен', () => {
  const plan = effectiveDay(MONDAY, [
    { weekday: 1, start: '12:00', end: '14:00' },
    { weekday: 1, start: '11:00', end: '12:30' },
  ], []);
  assert.deepEqual(plan.windows, [[660, 840]]);
  assert.deepEqual(mergeRanges([[10, 20], [20, 30], [40, 50]]), [[10, 30], [40, 50]]);
});

test('вместимость 2: первый клиент — основной, второй — резерв, третьему места нет', () => {
  const plan = effectiveDay(MONDAY, week, []);
  assert.deepEqual(
    buildSlots(plan, 45, 2, []).map((s) => [s.time, s.free, s.nextIsReserve]),
    [['11:00', 2, false], ['11:45', 2, false]],
  );
  const one = buildSlots(plan, 45, 2, [{ startTime: '11:00', durationMin: 45 }]);
  assert.deepEqual([one[0]?.taken, one[0]?.free, one[0]?.nextIsReserve], [1, 1, true]);
  const two = buildSlots(plan, 45, 2, [{ startTime: '11:00', durationMin: 45 }, { startTime: '11:00', durationMin: 45 }]);
  assert.deepEqual([two[0]?.free, two[0]?.nextIsReserve], [0, false]);
});

test('длительность слота — параметр: те же часы режутся по 30 и по 60 минут', () => {
  const plan = effectiveDay(MONDAY, week, []);
  assert.deepEqual(slotStarts(plan, 60).map(minToTime), ['11:00', '12:00']);
  assert.deepEqual(slotStarts(plan, 30).map(minToTime), ['11:00', '11:30', '12:00', '12:30']);
  assert.deepEqual(slotStarts(plan, 0), []);
});

test('пересечение считается по интервалу, а не по совпадению старта', () => {
  assert.equal(countOverlapping(660, 45, [{ startTime: '11:30', durationMin: 45 }]), 1);
  assert.equal(countOverlapping(660, 45, [{ startTime: '11:45', durationMin: 45 }]), 0, 'встык — не пересечение');
});

test('часы по настройкам для консультантов без графика; календарь гасит праздник', () => {
  const hours = { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
  assert.equal(fitsPlan(defaultHoursDay(THURSDAY, hours), 17 * 60, 45), true);
  assert.equal(fitsPlan(defaultHoursDay(THURSDAY, hours), 17 * 60 + 30, 45), false, 'конец после 18:00');
  assert.equal(defaultHoursDay('2026-10-24', hours).working, false, 'суббота');
  assert.equal(defaultHoursDay('2026-10-26', hours, (d) => d !== '2026-10-26').working, false, 'праздник в рабочий день недели');
});

test('«свободен с 11 до 13 и с 15 до 17» → два окна исключения (обед — промежуток)', () => {
  assert.deepEqual(intervalsToWindows([{ start: '15:00', end: '17:00' }, { start: '11:00', end: '13:00' }]), [
    { start: '11:00', end: '13:00' },
    { start: '15:00', end: '17:00' },
  ]);
});

test('пересекающиеся интервалы сливаются, пустой список — «не принимает»', () => {
  assert.deepEqual(intervalsToWindows([{ start: '11:00', end: '13:00' }, { start: '12:00', end: '14:00' }]), [{ start: '11:00', end: '14:00' }]);
  assert.equal(intervalsToWindows([]), null);
});

// ---------------------------------------------------------------------------
// Пул «серых» записей над снимком дня
// ---------------------------------------------------------------------------

const at = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

test('прямая запись к последнему свободному из пула оставила бы «серую» без консультанта', () => {
  const snap = snapshot([consultant('a'), consultant('b')], [booking('g1', null, '11:30'), booking('g2', null, '11:30')]);
  assert.equal(poolRoom(snap, at('11:30'), 45), 0, 'пул на 11:30 полон');
  assert.equal(starvedGreyBooking(snap, { id: null, consultantId: 'a', startTime: '11:30', durationMin: 45 })?.id, 'g1');
  assert.equal(starvedGreyBooking(snap, { id: null, consultantId: 'a', startTime: '11:00', durationMin: 45 })?.id, 'g1', 'пересечение, а не совпадение старта');
  assert.equal(starvedGreyBooking(snap, { id: null, consultantId: 'a', startTime: '12:15', durationMin: 45 }), null, 'после «серых» — можно');
});

test('консультант вне пула и запас в пуле записи к консультанту не мешают', () => {
  const snap = snapshot([consultant('a'), consultant('b'), consultant('owner', { autoAssign: false })], [booking('g1', null, '11:30')]);
  assert.equal(starvedGreyBooking(snap, { id: null, consultantId: 'owner', startTime: '11:30', durationMin: 45 }), null);
  assert.equal(starvedGreyBooking(snap, { id: null, consultantId: 'a', startTime: '11:30', durationMin: 45 }), null, 'b остаётся «серой»');
});

test('назначение «серой» самой себе пул не уменьшает; уже переполненный пул не запрещает лишнего', () => {
  const full = snapshot([consultant('a'), consultant('b')], [booking('g1', null, '11:30'), booking('g2', null, '11:30')]);
  assert.equal(starvedGreyBooking(full, { id: 'g1', consultantId: 'a', startTime: '11:30', durationMin: 45 }), null);

  // Пул уже в минусе (консультанта выключили): «серых» две, свободна одна.
  const over = snapshot([consultant('a'), consultant('b')], [
    booking('g1', null, '11:30'), booking('g2', null, '11:30'), booking('x', 'b', '11:30'),
  ]);
  assert.equal(poolRoom(over, at('11:30'), 45), -1);
  assert.equal(starvedGreyBooking(over, { id: 'x', consultantId: 'b', startTime: '11:30', durationMin: 45 }), null);
  assert.equal(starvedGreyBooking(over, { id: null, consultantId: 'a', startTime: '11:30', durationMin: 45 })?.id, 'g1', 'а последнюю свободную — отнимает');
});

test('записи к выключенному консультанту — в отдельном списке, а не пропадают из сетки', () => {
  // Снимок берёт только активных: 'gone' выключен, его запись y осталась.
  const snap = snapshot([consultant('a')], [booking('x', 'a', '11:00'), booking('y', 'gone', '11:00'), booking('g', null, '12:00')]);
  assert.deepEqual(orphanedBookings(snap).map((b) => b.id), ['y']);
  const day = describeDay(snap);
  assert.deepEqual(day.consultants.map((c) => [c.consultant.id, c.bookings.map((b) => b.id)]), [['a', ['x']]]);
  assert.deepEqual(day.unassigned.map((b) => b.id), ['g']);
  assert.deepEqual(day.orphaned.map((b) => b.id), ['y']);
  assert.deepEqual(describeDay(snap, 'a').orphaned.map((b) => b.id), ['y'], 'и при фильтре по консультанту');
});

test('describeDay: часы и слоты консультанта с графиком, у консультанта без графика слотов нет', () => {
  const snap = snapshot(
    [consultant('a', { usesSchedule: true }), consultant('b')],
    [booking('x', 'a', '11:00')],
    { a: { schedule: week, exceptions: [] } },
  );
  const [a, b] = describeDay(snap).consultants;
  assert.deepEqual(a?.hours, { start: '11:00', end: '13:00' });
  assert.deepEqual(a?.slots.map((s) => [s.time, s.free]), [['11:00', 0], ['11:45', 1]]);
  assert.deepEqual(b?.hours, { start: '09:00', end: '18:00' });
  assert.deepEqual(b?.slots, []);
});

// ---------------------------------------------------------------------------
// Резерв
// ---------------------------------------------------------------------------

test('освободился основной слот — старейший резерв становится основным', () => {
  const slot = [
    { id: 'r2', isReserve: true, createdAt: 20 },
    { id: 'r1', isReserve: true, createdAt: 10 },
  ];
  assert.equal(reserveToPromote(slot, 1), 'r1');
  assert.equal(reserveToPromote([{ id: 'm', isReserve: false, createdAt: 1 }, ...slot], 1), null, 'основное место занято');
  assert.equal(reserveToPromote([{ id: 'm', isReserve: false, createdAt: 1 }, ...slot], 2), 'r1', 'вместимость 2: место есть');
  assert.equal(reserveToPromote([], 1), null, 'резерва нет');
});
