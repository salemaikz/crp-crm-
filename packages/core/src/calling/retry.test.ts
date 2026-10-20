import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryStep, planNoAnswer, resolveRetryStep, resolveStepAt, validateRetrySettings } from './retry.js';
import { TEST_CALENDAR as CAL, TEST_SETTINGS, at } from './spec/vectors.js';

// Календарь тестов: пн–пт, окно [09:00, 18:00), 26.10.2026 — выходной (перенос), пояс UTC+5.
const R = { steps: ['+2h', 'nextWorkday@10:00'], maxAttempts: 3 };

test('parseRetryStep: сдвиги и следующий рабочий день', () => {
  assert.deepEqual(parseRetryStep('+2h'), { kind: 'shift', ms: 7_200_000 });
  assert.deepEqual(parseRetryStep('+45m'), { kind: 'shift', ms: 2_700_000 });
  assert.deepEqual(parseRetryStep('nextWorkday@10:00'), { kind: 'nextWorkday', hhmm: '10:00' });
  for (const bad of ['', '2h', '+0h', '+2d', '+h', 'nextWorkday@25:00', 'nextWorkday@9:00', 'nextworkday@10:00', '+2h ']) {
    assert.equal(parseRetryStep(bad), null, bad);
  }
});

test('validateRetrySettings', () => {
  assert.deepEqual(validateRetrySettings(R), []);
  assert.deepEqual(validateRetrySettings({ steps: [], maxAttempts: 1 }), []);
  assert.equal(validateRetrySettings({ steps: ['+2h'], maxAttempts: 3 }).length, 1);
  assert.equal(validateRetrySettings({ steps: ['bad', '+1h'], maxAttempts: 3 }).length, 1);
  assert.equal(validateRetrySettings({ steps: ['+1h'], maxAttempts: 0 }).length, 1);
  assert.equal(validateRetrySettings({ steps: Array(11).fill('+1h'), maxAttempts: 11 }).length, 1);
});

// Первый недозвон (attemptsBefore = 0) и второй (1) — векторы PROCESS 3.4, октябрь 2026.
const cases: Array<[string, number, string, string]> = [
  ['вт 14:20 +2ч в окне', 0, '2026-10-20 14:20', '2026-10-20 16:20'],
  ['вт 16:00 +2ч = 18:00 конец окна не входит → ср 10:00', 0, '2026-10-20 16:00', '2026-10-21 10:00'],
  ['вт 15:59 → 17:59 в окне', 0, '2026-10-20 15:59', '2026-10-20 17:59'],
  ['вт 16:30 → 18:30 вне окна → ср 10:00', 0, '2026-10-20 16:30', '2026-10-21 10:00'],
  ['вт 06:30 → 08:30 до окна → вт 10:00', 0, '2026-10-20 06:30', '2026-10-20 10:00'],
  ['вт 07:00 → 09:00 начало окна входит', 0, '2026-10-20 07:00', '2026-10-20 09:00'],
  ['пт 17:00 → 19:00 → пн 10:00 (26.10 выходной → вт 27.10)', 0, '2026-10-23 17:00', '2026-10-27 10:00'],
  ['сб 12:00 → вт 27.10 10:00', 0, '2026-10-24 12:00', '2026-10-27 10:00'],
  ['вс 25.10 10:00 → вт 27.10 10:00', 0, '2026-10-25 10:00', '2026-10-27 10:00'],
  ['пн 26.10 (праздник) 11:00 → вт 27.10 10:00', 0, '2026-10-26 11:00', '2026-10-27 10:00'],
  ['ср 28.10 10:14 → 12:14', 0, '2026-10-28 10:14', '2026-10-28 12:14'],
  ['второй: вт 12:20 → ср 10:00', 1, '2026-10-20 12:20', '2026-10-21 10:00'],
  ['второй: вт 08:30 → ср (не сегодня 10:00)', 1, '2026-10-20 08:30', '2026-10-21 10:00'],
  ['второй: пт 23.10 17:00 → вт 27.10 10:00', 1, '2026-10-23 17:00', '2026-10-27 10:00'],
  ['второй: чт 29.10 15:34 → пт 30.10 10:00', 1, '2026-10-29 15:34', '2026-10-30 10:00'],
  ['второй: пт 30.10 → пн 02.11 10:00', 1, '2026-10-30 12:00', '2026-11-02 10:00'],
];
for (const [title, before, from, want] of cases) {
  test(`planNoAnswer: ${title}`, () => {
    const p = planNoAnswer(before, at(from), R, CAL);
    assert.deepEqual(p, { kind: 'retry', attempts: before + 1, nextCallAt: at(want) });
  });
}

test('третий недозвон при maxAttempts = 3 → списание', () => {
  assert.deepEqual(planNoAnswer(2, at('2026-10-21 11:00'), R, CAL), { kind: 'write_off', attempts: 3 });
});

test('maxAttempts = 1: первый недозвон сразу списывает, шагов не надо', () => {
  assert.deepEqual(planNoAnswer(0, at('2026-10-20 11:00'), { steps: [], maxAttempts: 1 }, CAL), {
    kind: 'write_off',
    attempts: 1,
  });
});

test('настройки: другие шаги и лимит (4 попытки, +30m, +3h, завтра 15:00)', () => {
  const r = { steps: ['+30m', '+3h', 'nextWorkday@15:00'], maxAttempts: 4 };
  assert.equal((planNoAnswer(0, at('2026-10-20 12:00'), r, CAL) as { nextCallAt: number }).nextCallAt, at('2026-10-20 12:30'));
  assert.equal((planNoAnswer(1, at('2026-10-20 12:30'), r, CAL) as { nextCallAt: number }).nextCallAt, at('2026-10-20 15:30'));
  assert.equal((planNoAnswer(2, at('2026-10-20 15:30'), r, CAL) as { nextCallAt: number }).nextCallAt, at('2026-10-21 15:00'));
  assert.equal(planNoAnswer(3, at('2026-10-21 15:30'), r, CAL).kind, 'write_off');
});

test('сдвиг вне окна: время берётся из первого nextWorkday@, а не из 10:00 кода', () => {
  const r = { steps: ['+2h', 'nextWorkday@15:00'], maxAttempts: 3 };
  const p = planNoAnswer(0, at('2026-10-20 16:30'), r, CAL);
  assert.deepEqual(p, { kind: 'retry', attempts: 1, nextCallAt: at('2026-10-21 15:00') });
});

test('сдвиг вне окна без шага nextWorkday@: начало окна звонков календаря', () => {
  const r = { steps: ['+2h', '+4h'], maxAttempts: 3 };
  const p = planNoAnswer(0, at('2026-10-20 16:30'), r, CAL);
  assert.deepEqual(p, { kind: 'retry', attempts: 1, nextCallAt: at('2026-10-21 09:00') });
});

test('шагов меньше нужного (невалидные настройки): используется последний шаг', () => {
  const r = { steps: ['+1h'], maxAttempts: 4 };
  const p = planNoAnswer(2, at('2026-10-20 10:00'), r, CAL);
  assert.deepEqual(p, { kind: 'retry', attempts: 3, nextCallAt: at('2026-10-20 11:00') });
});

test('пустые шаги при maxAttempts > 1 и неверный шаг — исключения', () => {
  assert.throws(() => planNoAnswer(0, at('2026-10-20 10:00'), { steps: [], maxAttempts: 3 }, CAL), RangeError);
  assert.throws(() => resolveRetryStep('soon', at('2026-10-20 10:00'), CAL), RangeError);
});

test('resolveRetryStep без списка шагов: вне окна → начало окна', () => {
  assert.equal(resolveRetryStep('+8h', at('2026-10-20 12:00'), CAL), at('2026-10-21 09:00'));
});

test('календарь внедряется: фиктивный календарь без выходных', () => {
  const always: typeof CAL = {
    ...CAL,
    isWorkday: () => true,
    isInCallWindow: () => true,
    nextWorkdayAt: (t, hhmm) => at(`${CAL.localDay(t + 86_400_000)} ${hhmm}`),
  };
  assert.equal(planNoAnswer(0, at('2026-10-24 23:00'), R, always).kind, 'retry');
  const p = planNoAnswer(1, at('2026-10-24 12:00'), R, always);
  assert.deepEqual(p, { kind: 'retry', attempts: 2, nextCallAt: at('2026-10-25 10:00') });
});

test('согласованность с настройками тест-векторов K1d', () => {
  assert.deepEqual(validateRetrySettings(TEST_SETTINGS.retry), []);
  assert.deepEqual(planNoAnswer(0, at('2026-10-20 14:20'), TEST_SETTINGS.retry, CAL), {
    kind: 'retry',
    attempts: 1,
    nextCallAt: at('2026-10-20 16:20'),
  });
});

test('resolveStepAt: сдвиг без окна звонков и следующий рабочий день', () => {
  const from = Date.parse('2026-10-20T16:00:00+05:00');
  assert.equal(resolveStepAt('+2h', from, CAL), from + 7_200_000);
  assert.equal(resolveStepAt('nextWorkday@10:00', from, CAL), Date.parse('2026-10-21T10:00:00+05:00'));
  assert.throws(() => resolveStepAt('+0h', from, CAL), RangeError);
});
