import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJsonParam, isUniqueViolation, jsonParam, toCamel } from '../../src/server/platform/db/core';

test('toCamel как postgres.toCamel', () => {
  assert.equal(toCamel('space_id'), 'spaceId');
  assert.equal(toCamel('a_b_c'), 'aBC');
  assert.equal(toCamel('id'), 'id');
});

test('jsonParam: бренд виден из других бандлов, undefined запрещён', () => {
  assert.equal(isJsonParam(jsonParam({ a: 1 })), true);
  assert.equal(isJsonParam({ value: 1 }), false);
  assert.throws(() => jsonParam(undefined));
});

test('isUniqueViolation по коду 23505', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation(new Error('x')), false);
});
