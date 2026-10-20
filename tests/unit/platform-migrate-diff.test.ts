import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffMigrations, sha256Hex } from '../../src/server/platform/db/migrate';

test('sha256Hex — известный вектор', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('diffMigrations: pending, unknown, changed', () => {
  const st = diffMigrations(['b', 'a', 'c'], ['a', 'x'], { a: 'h1' }, { a: 'h1' });
  assert.deepEqual(st, { files: ['a', 'b', 'c'], applied: ['a', 'x'], pending: ['b', 'c'], unknown: ['x'], changed: [] });
  assert.deepEqual(diffMigrations(['a'], ['a'], { a: 'h2' }, { a: 'h1' }).changed, ['a']);
});

test('diffMigrations: файл без записанной суммы не считается изменённым пока сумм нет у диска', () => {
  assert.deepEqual(diffMigrations(['a'], ['a']).changed, []);
});
