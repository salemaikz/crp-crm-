// Определения показателей (R3a, D-261, D-262): доли, «звонков в час», мягкая норма, суммы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsPerHour, CLOSING_KINDS, isBelowTarget, ISSUE_KINDS, rate, toKzt } from '../../../src/server/domain/reports/definitions';

test('rate: ноль в знаменателе — null, один знак после запятой', () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(5, 0), null);
  assert.equal(rate(1, 8), 12.5);
  assert.equal(rate(1, 3), 33.3);
  assert.equal(rate(2, 3), 66.7);
  assert.equal(rate(3, 3), 100);
  assert.equal(rate(0, 4), 0);
});

test('callsPerHour: нет часов — null, иначе один знак', () => {
  assert.equal(callsPerHour(0, 0), null);
  assert.equal(callsPerHour(10, 0), null);
  assert.equal(callsPerHour(25, 2), 12.5);
  assert.equal(callsPerHour(10, 3), 3.3);
  assert.equal(callsPerHour(0, 4), 0);
});

test('ниже нормы — только отметка: норма не задана или часов нет — не отмечаем', () => {
  assert.equal(isBelowTarget(9.9, 10), true);
  assert.equal(isBelowTarget(10, 10), false);
  assert.equal(isBelowTarget(0, 10), true);
  assert.equal(isBelowTarget(5, null), false);
  assert.equal(isBelowTarget(null, 10), false);
});

test('виды выдачи и закрытий — как в определениях', () => {
  assert.deepEqual([...ISSUE_KINDS], ['auto', 'manual', 'return', 'inbound', 'proposal']);
  assert.deepEqual([...CLOSING_KINDS], ['not_interested', 'not_target', 'do_not_call']);
});

test('toKzt: bigint-строка в число; не безопасное целое — ошибка', () => {
  assert.equal(toKzt('1500000'), 1_500_000);
  assert.equal(toKzt(null), 0);
  assert.throws(() => toKzt('9007199254740993'), RangeError);
});
