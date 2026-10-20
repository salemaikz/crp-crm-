/**
 * Подбор консультанта над снимком дня. Что здесь стережётся:
 *   • кандидат всегда тот, кого сервер потом и правда запишет: слот графика начинается в это время
 *     и в нём есть место — иначе оператор выбирает предложенного, а запись падает с 409;
 *   • порядок: направление запроса → меньше записей в этот день → sort → имя;
 *   • второй клиент на слот вместимостью 2 предлагается резервом;
 *   • тот, кого запись отняла бы у «серых» записей пула, не предлагается.
 * Ключи направлений здесь произвольные — это данные настроек, а не код.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankAssignCandidates, rankConsultants } from './suggest';
import type { ScheduleWindow } from './types';
import { MONDAY_10_14, MONDAY_11_13, booking, consultant, snapshot } from './fixtures';

interface Spec {
  directions?: string[];
  schedule?: ScheduleWindow[] | null;
  capacity?: number;
  autoAssign?: boolean;
  active?: boolean;
  sort?: number;
  name?: string;
}

function build(entries: Array<[id: string, spec: Spec]>, bookings = [] as ReturnType<typeof booking>[]) {
  const schedules: Record<string, { schedule: ScheduleWindow[]; exceptions: [] }> = {};
  const list = entries.map(([id, s]) => {
    schedules[id] = { schedule: s.schedule === null ? [] : (s.schedule ?? MONDAY_11_13), exceptions: [] };
    return consultant(id, {
      name: s.name ?? id, directions: s.directions ?? [], capacity: s.capacity ?? 1, usesSchedule: s.schedule !== null,
      autoAssign: s.autoAssign ?? false, active: s.active ?? true, sort: s.sort ?? 0,
    });
  });
  return snapshot(list, bookings, schedules);
}

const at = (startTime: string) => ({ startTime });
const ids = (list: { consultantId: string }[]) => list.map((c) => c.consultantId);

test('предлагается только тот, у кого в это время начинается слот графика', () => {
  const snap = build([['a', {}], ['b', { schedule: MONDAY_10_14 }]]);
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), '')), ['a'], '11:00 — слот A; у B слот 10:45–11:30');
  assert.deepEqual(ids(rankConsultants(snap, at('11:30'), '')), ['b'], 'внутри слота A 11:00–11:45 — не его время');
  assert.deepEqual(ids(rankConsultants(snap, at('11:45'), '')), ['a']);
  assert.deepEqual(ids(rankConsultants(snap, at('13:00'), '')), ['b'], 'у A день кончается в 13:00');
  assert.deepEqual(ids(rankConsultants(snap, at('09:00'), '')), [], 'до начала графика — никого');
  assert.deepEqual(ids(rankConsultants(snap, at('12:30'), '')), [], 'слот 11:45 у A занимает до 12:30, следующего нет');
});

test('без графика, выключенный и выходной — не предлагаются для новой записи', () => {
  const snap = build([
    ['noSchedule', { schedule: null, autoAssign: true }],
    ['off', { active: false }],
    ['friday', { schedule: [{ weekday: 5, start: '11:00', end: '13:00' }] }],
    ['a', {}],
  ]);
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), '')), ['a']);
});

test('занятый слот вместимостью 1 не предлагается', () => {
  const snap = build([['a', {}], ['b', {}]], [booking('b1', 'a', '11:00')]);
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), '')), ['b']);
});

test('совпавшее направление первым, даже если консультант загружен больше', () => {
  const snap = build(
    [
      ['b', { directions: ['marketing'], sort: 0 }],
      ['a', { directions: ['program', 'consulting'], sort: 5, capacity: 2 }],
    ],
    [booking('a1', 'a', '11:45'), booking('a2', 'a', '11:45')],
  );
  const ranked = rankConsultants(snap, at('11:00'), 'program');
  assert.deepEqual(ids(ranked), ['a', 'b']);
  assert.deepEqual(ranked[0], { consultantId: 'a', name: 'a', directionMatch: true, dayLoad: 2, reserve: false });
  assert.equal(ranked[1]?.directionMatch, false);
});

test('из двух подходящих по направлению первым — менее загруженный в этот день', () => {
  const snap = build(
    [
      ['b', { directions: ['marketing'], sort: 0 }],
      ['d', { directions: ['marketing', 'training'], sort: 1 }],
      ['a', { directions: ['program'], sort: 2 }],
    ],
    [booking('b1', 'b', '11:45')],
  );
  const ranked = rankConsultants(snap, at('11:00'), 'marketing');
  assert.deepEqual(ids(ranked), ['d', 'b', 'a']);
  assert.deepEqual(ranked.map((c) => [c.directionMatch, c.dayLoad]), [[true, 0], [true, 1], [false, 0]]);
});

test('без направления — по загрузке, при равной — по sort, потом по имени', () => {
  const snap = build(
    [
      ['c', { sort: 1, name: 'Ерлан' }],
      ['a', { sort: 1, name: 'Айгуль' }],
      ['b', { sort: 0, name: 'Яна' }],
      ['busy', { sort: 0, name: 'Борис' }],
    ],
    [booking('x', 'busy', '11:45')],
  );
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), null)), ['b', 'a', 'c', 'busy']);
  assert.ok(rankConsultants(snap, at('11:00'), 'unknown_key').every((c) => !c.directionMatch), 'ключ, которого нет ни у кого, ни с кем не совпадает');
});

test('слот вместимостью 2 с одной записью предлагается резервом, с двумя — нет', () => {
  const one = build([['a', { capacity: 2, directions: ['program'] }]], [booking('m', 'a', '11:00')]);
  assert.deepEqual(rankConsultants(one, at('11:00'), 'program'), [
    { consultantId: 'a', name: 'a', directionMatch: true, dayLoad: 1, reserve: true },
  ]);
  const two = build([['a', { capacity: 2 }]], [booking('m', 'a', '11:00'), booking('r', 'a', '11:00')]);
  assert.deepEqual(rankConsultants(two, at('11:00'), ''), []);
  assert.equal(rankConsultants(one, at('11:45'), '')[0]?.reserve, false, 'соседний пустой слот — основной');
});

test('последнего свободного из пула запись не забирает у «серой» на то же время', () => {
  const grey = booking('g', null, '11:00');
  const snap = build([['b', { autoAssign: true }], ['a', { autoAssign: false }]], [grey]);
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), '')), ['a'], 'B нужен «серой» на 11:00');
  assert.deepEqual(ids(rankConsultants(snap, at('11:45'), '')).sort(), ['a', 'b'], 'после «серой» — свободен');

  const twoInPool = build([['b', { autoAssign: true }], ['d', { autoAssign: true }]], [grey]);
  assert.deepEqual(ids(rankConsultants(twoInPool, at('11:00'), '')).sort(), ['b', 'd'], 'второй из пула остаётся «серой»');
});

test('подбор для самой «серой» (bookingId) не считает её отнятой у себя', () => {
  const grey = booking('g', null, '11:00');
  const snap = build([['b', { autoAssign: true }]], [grey]);
  assert.deepEqual(ids(rankConsultants(snap, at('11:00'), '', { bookingId: 'g' })), ['b']);
});

test('назначение «серой»: свободные в её время, и без графика тоже, по направлению и загрузке, без резерва', () => {
  const grey = booking('g', null, '11:00', { directionKey: 'marketing' });
  const snap = build(
    [
      ['pool', { schedule: null, autoAssign: true }],
      ['b', { directions: ['marketing'] }],
      ['busy', { directions: ['marketing'], capacity: 2 }],
      ['late', { schedule: MONDAY_10_14 }],
    ],
    [grey, booking('x', 'busy', '11:00'), booking('y', 'pool', '15:00')],
  );
  const ranked = rankAssignCandidates(snap, grey, grey.directionKey);
  assert.deepEqual(ids(ranked), ['b', 'pool'], 'занятый (даже с запасом) и тот, у кого не слот, — не кандидаты');
  assert.deepEqual(ranked.map((c) => [c.directionMatch, c.dayLoad, c.reserve]), [[true, 0, false], [false, 1, false]]);
});
