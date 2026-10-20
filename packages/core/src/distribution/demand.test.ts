import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDemand, countWorkingOperators, type DemandInput } from './demand';
import { workdaysAfter } from './schedule';
import { at, TEST_CALENDAR } from './testCalendar';

const schedule = { from: '08:00', to: '18:00', everyMin: 60, workdaysOnly: true };

function input(local: string, o: Partial<DemandInput> = {}): DemandInput {
  const now = at(local);
  const today = TEST_CALENDAR.localDay(now);
  return {
    now,
    calendar: TEST_CALENDAR,
    schedule,
    capPerOperator: 40,
    bufferDays: 0.5,
    todayOperators: 10,
    issuedToday: 120,
    days: workdaysAfter(today, 7, TEST_CALENDAR).map((date) => ({ date, operators: 10 })),
    returnsExpected: 35,
    returnsDueBy: () => 5,
    poolReady: 312,
    ...o,
  };
}

test('пример INTEGRATIONS 5.3: сегодня идёт раздача — needToday 0, needNext 103', () => {
  const r = computeDemand(input('2026-10-28 10:00'));
  assert.deepEqual(r.today, {
    date: '2026-10-28', isWorkday: true, operators: 10, capPerOperator: 40, capacity: 400, issued: 120, remaining: 280,
  });
  assert.equal(r.needToday, 0);
  assert.deepEqual(r.next, { date: '2026-10-28', capacity: 280, returnsDue: 5 });
  assert.equal(r.needNext, 103); // ceil(280·1,5)=420 − 5 − 312
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days[0], { date: '2026-10-29', operators: 10, capacity: 400 });
  // needTotal = 280 + 7·400 − 35 − 312
  assert.equal(r.needTotal, 280 + 2800 - 35 - 312);
});

test('пул меньше остатка: needToday = remaining − poolReady', () => {
  const r = computeDemand(input('2026-10-28 10:00', { poolReady: 100 }));
  assert.equal(r.needToday, 180);
  assert.equal(r.needNext, 420 - 5 - 100);
});

test('вечером после последнего тика ближайший день — завтра, capacity(D) полная', () => {
  const r = computeDemand(input('2026-10-28 19:00', { issuedToday: 400, poolReady: 50 }));
  assert.deepEqual(r.next, { date: '2026-10-29', capacity: 400, returnsDue: 5 });
  assert.equal(r.needNext, 600 - 5 - 50);
  assert.equal(r.needToday, 0);
});

test('ночью до начала раздачи сегодня — ближайший день сегодня, с остатком', () => {
  const r = computeDemand(input('2026-10-28 02:00', { issuedToday: 0, poolReady: 0 }));
  assert.equal(r.next?.date, '2026-10-28');
  assert.equal(r.next?.capacity, 400);
  assert.equal(r.needNext, 600 - 5);
});

test('нерабочий день: capacity 0, needToday 0, ближайший — следующий рабочий (перенос 26.10)', () => {
  const r = computeDemand(input('2026-10-25 23:00', { issuedToday: 0 }));
  assert.equal(r.today.isWorkday, false);
  assert.equal(r.today.capacity, 0);
  assert.equal(r.needToday, 0);
  assert.equal(r.next?.date, '2026-10-27');
  assert.equal(r.days[0]?.date, '2026-10-27');
});

test('выдано больше лимита (ручной override) — remaining не уходит в минус', () => {
  const r = computeDemand(input('2026-10-28 10:00', { issuedToday: 500 }));
  assert.equal(r.today.remaining, 0);
  assert.equal(r.next?.capacity, 0);
});

test('возвраты занимают лимит: needNext и needTotal уменьшаются', () => {
  const a = computeDemand(input('2026-10-28 19:00', { poolReady: 0, returnsDueBy: () => 0, returnsExpected: 0 }));
  const b = computeDemand(input('2026-10-28 19:00', { poolReady: 0, returnsDueBy: () => 40, returnsExpected: 100 }));
  assert.equal(a.needNext - b.needNext, 40);
  assert.equal(a.needTotal - b.needTotal, 100);
});

test('дробный буфер без плавающей ошибки; нет рабочих дней впереди — needNext 0', () => {
  const r = computeDemand(input('2026-10-28 19:00', { bufferDays: 0.1, poolReady: 0, returnsDueBy: () => 0 }));
  assert.equal(r.needNext, 440);
  const none = computeDemand(input('2026-10-28 19:00', { days: [] }));
  assert.equal(none.next, null);
  assert.equal(none.needNext, 0);
});

test('операторы по участникам: считаются только «работает»', () => {
  assert.equal(countWorkingOperators([{ status: 'working' }, { status: 'paused' }, { status: 'absent' }, { status: 'working' }]), 2);
});
