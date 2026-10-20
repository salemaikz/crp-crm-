// slotFor (worker-design §2): чистая функция по расписанию и календарю. Прогоняется и под TZ=UTC, и под TZ=Asia/Almaty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import { slotFor } from '../../../src/server/platform/jobs/slot';
import type { ScheduleSpec } from '../../../src/server/platform/jobs/types';

const cal = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [{ date: '2026-10-26', kind: 'holiday' }],
});
const OFFSET = 5 * 3600_000;
/** 'YYYY-MM-DD HH:MM[:SS]' местного времени → epoch-мс. */
const at = (local: string): number => Date.parse(`${local.replace(' ', 'T')}${local.length === 16 ? ':00' : ''}Z`) - OFFSET;
const key = (spec: ScheduleSpec, local: string) => slotFor(spec, at(local), cal)?.key ?? null;

test('daily 03:30: до срока нет слота, после — ключ на весь остаток суток', () => {
  const s: ScheduleSpec = { kind: 'daily', at: '03:30', days: 'all' };
  assert.equal(key(s, '2026-10-28 03:29'), null);
  assert.equal(key(s, '2026-10-28 03:30'), '2026-10-28');
  assert.equal(key(s, '2026-10-28 23:59'), '2026-10-28');
  assert.equal(key(s, '2026-10-29 03:30'), '2026-10-29');
  assert.equal(slotFor(s, at('2026-10-28 12:00'), cal)?.at, at('2026-10-28 03:30'));
});

test('daily workdays: перенесённый выходной и суббота — без слота', () => {
  const s: ScheduleSpec = { kind: 'daily', at: '07:30', days: 'workdays' };
  assert.equal(key(s, '2026-10-26 12:00'), null);
  assert.equal(key(s, '2026-10-24 12:00'), null);
  assert.equal(key(s, '2026-10-27 12:00'), '2026-10-27');
});

test('grid 08:00–18:00 каждые 60, grace 15', () => {
  const s: ScheduleSpec = { kind: 'grid', from: '08:00', to: '18:00', everyMin: 60, days: 'workdays', graceMin: 15 };
  assert.equal(key(s, '2026-10-28 07:59'), null);
  assert.equal(key(s, '2026-10-28 08:00:20'), '2026-10-28T08:00');
  assert.equal(key(s, '2026-10-28 11:14'), '2026-10-28T11:00');
  assert.equal(key(s, '2026-10-28 11:15'), '2026-10-28T11:00');
  assert.equal(key(s, '2026-10-28 11:16'), null);
  assert.equal(key(s, '2026-10-28 18:05'), '2026-10-28T18:00');
  assert.equal(key(s, '2026-10-28 18:20'), null);
  assert.equal(key(s, '2026-10-26 11:00'), null);
});

test('interval 5: от местной полуночи', () => {
  const s: ScheduleSpec = { kind: 'interval', everyMin: 5 };
  assert.equal(key(s, '2026-10-28 14:07'), '2026-10-28T14:05');
  assert.equal(key(s, '2026-10-28 00:00'), '2026-10-28T00:00');
  assert.equal(key(s, '2026-10-28 23:59'), '2026-10-28T23:55');
});

test('times [07:30, 13:00]: последний наступивший момент', () => {
  const s: ScheduleSpec = { kind: 'times', at: ['13:00', '07:30'], days: 'all' };
  assert.equal(key(s, '2026-10-28 07:00'), null);
  assert.equal(key(s, '2026-10-28 12:59'), '2026-10-28T07:30');
  assert.equal(key(s, '2026-10-28 13:00'), '2026-10-28T13:00');
});

test('manual — всегда null; плохой шаг сетки — ошибка', () => {
  assert.equal(slotFor({ kind: 'manual' }, at('2026-10-28 12:00'), cal), null);
  assert.throws(() => slotFor({ kind: 'interval', everyMin: 0 }, at('2026-10-28 12:00'), cal), RangeError);
});

test('свойство: слот не позже now, ключ однозначно задаёт начало слота', () => {
  const specs: ScheduleSpec[] = [
    { kind: 'daily', at: '03:30', days: 'all' },
    { kind: 'times', at: ['07:30', '13:00'], days: 'workdays' },
    { kind: 'grid', from: '08:00', to: '18:00', everyMin: 30, days: 'workdays', graceMin: 10 },
    { kind: 'interval', everyMin: 5 },
  ];
  const seen = new Map<string, number>();
  for (let t = at('2026-10-27 00:00'); t < at('2026-10-30 00:00'); t += 7 * 60_000 + 13_000) {
    for (const [i, spec] of specs.entries()) {
      const slot = slotFor(spec, t, cal);
      if (!slot) continue;
      assert.ok(slot.at <= t, 'слот в будущем');
      const id = `${i}:${slot.key}`;
      assert.equal(seen.get(id) ?? slot.at, slot.at, 'один ключ — два разных начала');
      seen.set(id, slot.at);
    }
  }
});
