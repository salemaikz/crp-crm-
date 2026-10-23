// Срок перезвона по касанию: разбор шагов и расчёт (pipeline-v2 §4.2). Синтетические даты, октябрь–ноябрь 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCallbackStep, resolveCallbackDue, stepForTouch } from './callbackSchedule.js';
import { at, TEST_CALENDAR } from './spec/vectors.js';
import { createWorkCalendar } from '../time/index.js';

/** Настройки установки: Asia/Almaty, пн–пт, окно 09:00–18:00; 26.10.2026 — выходной (перенос). */
const kzSettings = () => ({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [{ date: '2026-10-26', kind: 'holiday' as const, note: 'перенос' }],
});

const STEPS = ['+3d', '+7d', '+14d'];
// Среда 28.10.2026 11:00 (местное).
const NOW = at('2026-10-28 11:00');

test('разбор шагов: +Nd, +Nd@HH:MM, границы N', () => {
  assert.deepEqual(parseCallbackStep('+3d'), { days: 3, hhmm: null });
  assert.deepEqual(parseCallbackStep('+7d@10:30'), { days: 7, hhmm: '10:30' });
  assert.deepEqual(parseCallbackStep('+365d'), { days: 365, hhmm: null });
  for (const bad of ['+0d', '+366d', '3d', '+3h', '+3d@25:00', '+3d@9:00', '', '+1000d']) assert.equal(parseCallbackStep(bad), null, bad);
});

test('шаг по касанию: 1/2/3/4/9 → +3d/+7d/+14d/+14d/+14d', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map((k) => stepForTouch(STEPS, k)), ['+3d', '+7d', '+14d', '+14d', '+14d']);
  assert.throws(() => stepForTouch([], 1), RangeError);
});

test('касания 1–4 от четверга 29.10: +3d → пн 02.11 (вс → рабочий), +7d, +14d, +14d; без времени — начало окна, точность day', () => {
  const now = at('2026-10-29 11:00');
  const got = [1, 2, 3, 4].map((k) => resolveCallbackDue(STEPS, k, now, TEST_CALENDAR));
  assert.deepEqual(got, [
    { at: at('2026-11-02 09:00'), precision: 'day' },
    { at: at('2026-11-05 09:00'), precision: 'day' },
    { at: at('2026-11-12 09:00'), precision: 'day' },
    { at: at('2026-11-12 09:00'), precision: 'day' },
  ]);
});

test('суббота → понедельник; праздничный понедельник пропускается', () => {
  // Ср 28.10 + 3 = сб 31.10 → пн 02.11.
  assert.equal(resolveCallbackDue(STEPS, 1, NOW, TEST_CALENDAR).at, at('2026-11-02 09:00'));
  // Пт 23.10 + 3 = пн 26.10 (выходной, перенос) → вт 27.10.
  assert.equal(resolveCallbackDue(STEPS, 1, at('2026-10-23 15:00'), TEST_CALENDAR).at, at('2026-10-27 09:00'));
});

test('шаг со временем: точность time, время из шага', () => {
  assert.deepEqual(resolveCallbackDue(['+1d@14:30'], 1, NOW, TEST_CALENDAR), { at: at('2026-10-29 14:30'), precision: 'time' });
  // Поздний вечер: сутки считаются календарные, а не по 24 часа.
  assert.deepEqual(resolveCallbackDue(['+1d'], 1, at('2026-10-28 23:50'), TEST_CALENDAR), { at: at('2026-10-29 09:00'), precision: 'day' });
});

test('настоящий календарь установки: те же сроки, не зависят от TZ процесса', () => {
  const cal = createWorkCalendar(kzSettings());
  const r = resolveCallbackDue(STEPS, 1, at('2026-10-29 11:00'), cal);
  assert.equal(r.at, at('2026-11-02 09:00'));
  assert.equal(r.precision, 'day');
});

test('неверный шаг в настройках — RangeError', () => {
  assert.throws(() => resolveCallbackDue(['+3h'], 1, NOW, TEST_CALENDAR), RangeError);
});
