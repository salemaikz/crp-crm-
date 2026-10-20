// Ключи advisory-блокировок: значения всех ключей и классов различны (db/locks.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_LOCK_VALUES } from '../../src/server/platform/db/locks';

test('значения ключей и классов блокировок уникальны', () => {
  const values = Object.values(ALL_LOCK_VALUES);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(Number.isInteger(v) && v > 0);
});

test('классы двухключевых блокировок помещаются в int4', () => {
  for (const k of ['SKIP_LOCK_CLASS', 'JOB_LOCK_CLASS'] as const) assert.ok(ALL_LOCK_VALUES[k] <= 2_147_483_647, k);
});
