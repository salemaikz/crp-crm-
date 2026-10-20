// Свойства рабочего календаря: детерминированный генератор с seed, без новых зависимостей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkCalendar } from './calendar';
import { addLocalDays, localDayOf } from './zone';
import type { CalendarSettings, HHMM, Ms } from './types';

const CASES = 2500;

/** mulberry32: маленький детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

// Пояса с переходом на летнее время и без; Алматы меняла смещение 01.03.2024.
const ZONES = ['Asia/Almaty', 'UTC', 'Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe'];
const HOUR = 3_600_000;
const FROM = Date.UTC(2023, 0, 1);
const SPAN_MS = 4 * 365 * 24 * HOUR;

const hhmm = (min: number): HHMM => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function genSettings(r: Rng): CalendarSettings {
  const workdays = [1, 2, 3, 4, 5, 6, 7].filter(() => r.chance(0.7));
  if (workdays.length === 0) workdays.push(r.int(1, 7));
  const s = r.int(0, 20 * 60);
  const work = { start: hhmm(s), end: hhmm(r.int(s + 1, 24 * 60 - 1)) };
  const cs = r.int(0, 20 * 60);
  const call = { start: hhmm(cs), end: hhmm(r.int(cs + 1, 24 * 60 - 1)) };
  const base = Date.UTC(2023, 0, 1);
  const holidays = Array.from({ length: r.int(0, 40) }, () => ({
    date: new Date(base + r.int(0, 4 * 365) * 86_400_000).toISOString().slice(0, 10),
    kind: r.pick(['holiday', 'workday'] as const),
  }));
  return { timezone: r.pick(ZONES), workdays, workHours: work, callWindow: call, holidays };
}

const moment = (r: Rng): Ms => FROM + Math.floor(r.next() * SPAN_MS);

test(`свойство: nextWorkingMoment(x) ≥ x, рабочий, идемпотентен и монотонен (${CASES} случаев)`, () => {
  const r = rng(201);
  for (let i = 0; i < CASES; i++) {
    const s = genSettings(r);
    const cal = createWorkCalendar(s);
    const x = moment(r);
    const y = x + r.int(0, 10 * 24 * 60) * 60_000;
    const ctx = `случай ${i}: x=${new Date(x).toISOString()} ${JSON.stringify(s)}`;
    const nx = cal.nextWorkingMoment(x);
    assert.ok(nx >= x, `${ctx}\nnextWorkingMoment ${new Date(nx).toISOString()} < x`);
    assert.ok(cal.isWorkingMoment(nx), `${ctx}\nрезультат ${new Date(nx).toISOString()} не рабочий`);
    assert.equal(cal.nextWorkingMoment(nx), nx, `${ctx}\nне идемпотентен`);
    if (cal.isWorkingMoment(x)) assert.equal(nx, x, `${ctx}\nрабочий x сдвинут`);
    assert.ok(cal.nextWorkingMoment(y) >= nx, `${ctx}\nне монотонен для y=${new Date(y).toISOString()}`);
    const nc = cal.nextCallMoment(x);
    assert.ok(nc >= x && cal.isInCallWindow(nc), `${ctx}\nnextCallMoment ${new Date(nc).toISOString()}`);
  }
});

test(`свойство: addWorkdays монотонна по n и по дню, результат — рабочий день (${CASES} случаев)`, () => {
  const r = rng(202);
  for (let i = 0; i < CASES; i++) {
    const s = genSettings(r);
    const cal = createWorkCalendar(s);
    const d1 = localDayOf(moment(r), s.timezone);
    const d2 = addLocalDays(d1, r.int(0, 30));
    const n = r.int(1, 20);
    const ctx = `случай ${i}: d1=${d1} d2=${d2} n=${n} ${JSON.stringify(s)}`;
    const a = cal.addWorkdays(d1, n);
    assert.ok(cal.isWorkday(a), `${ctx}\n${a} не рабочий день`);
    assert.ok(a > d1, `${ctx}\n${a} не позже ${d1}`);
    assert.ok(cal.addWorkdays(d1, n + 1) > a, `${ctx}\nпо n не строго возрастает`);
    assert.ok(cal.addWorkdays(d2, n) >= a, `${ctx}\nпо дню не монотонна`);
    assert.equal(cal.addWorkdays(d1, 1), cal.nextWorkday(d1), `${ctx}\naddWorkdays(1) ≠ nextWorkday`);
  }
});

test(`свойство: addWorkingMs ≥ at и монотонна по ms (2000 случаев)`, () => {
  const r = rng(203);
  for (let i = 0; i < 2000; i++) {
    const s = genSettings(r);
    const cal = createWorkCalendar(s);
    const x = moment(r);
    const m1 = r.int(0, 30 * 60) * 60_000;
    const m2 = m1 + r.int(0, 10 * 60) * 60_000;
    const ctx = `случай ${i}: x=${new Date(x).toISOString()} m1=${m1} m2=${m2} ${JSON.stringify(s)}`;
    const a = cal.addWorkingMs(x, m1);
    assert.ok(a >= x, `${ctx}\nвозврат раньше начала`);
    assert.ok(cal.addWorkingMs(x, m2) >= a, `${ctx}\nне монотонна по ms`);
  }
});
