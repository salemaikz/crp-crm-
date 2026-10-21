// staleDaysOf (B4b, §3.5, D-244): порог ровно N календарных дней, только открытые, этап без staleDays не считается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleDaysOf } from '../../../src/server/domain/deals/rules';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 6, 0);

test('ровно N дней — залежалась, на минуту меньше — нет', () => {
  assert.equal(staleDaysOf({ status: 'open', stageChangedAt: NOW - 14 * DAY }, { staleDays: 14 }, NOW), 14);
  assert.equal(staleDaysOf({ status: 'open', stageChangedAt: NOW - 14 * DAY + 60_000 }, { staleDays: 14 }, NOW), null);
});

test('возвращает фактическое число дней', () => {
  assert.equal(staleDaysOf({ status: 'open', stageChangedAt: NOW - 20 * DAY - 5 * 3_600_000 }, { staleDays: 14 }, NOW), 20);
});

test('won, lost, этап без staleDays и неизвестный этап — null', () => {
  const old = NOW - 100 * DAY;
  assert.equal(staleDaysOf({ status: 'won', stageChangedAt: old }, { staleDays: 14 }, NOW), null);
  assert.equal(staleDaysOf({ status: 'lost', stageChangedAt: old }, { staleDays: 14 }, NOW), null);
  assert.equal(staleDaysOf({ status: 'open', stageChangedAt: old }, { staleDays: null }, NOW), null);
  assert.equal(staleDaysOf({ status: 'open', stageChangedAt: old }, undefined, NOW), null);
});
