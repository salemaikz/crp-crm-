// Схема тела PATCH /api/cards/[id]: режим с версией (много полей) и режим «одно поле» без версии.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchCardBody } from '../../../src/server/domain/clients/input';

test('один ключ без version — допустимо', () => {
  assert.equal(patchCardBody.safeParse({ set: { custom: { plan: 'а' } }, expect: { custom: { plan: null } } }).success, true);
});

test('два ключа без version — отказ', () => {
  const r = patchCardBody.safeParse({ set: { custom: { plan: 'а', note: 'б' } }, expect: { custom: { plan: null, note: null } } });
  assert.equal(r.success, false);
});

test('ноль ключей без version — отказ', () => {
  assert.equal(patchCardBody.safeParse({ set: { custom: {} }, expect: { custom: {} } }).success, false);
});

test('с version допустимо любое число полей, прежний режим не меняется', () => {
  const ok = patchCardBody.safeParse({ version: 3, set: { custom: { plan: 'а', note: 'б' } }, expect: { custom: { plan: null, note: null } } });
  assert.equal(ok.success, true);
});

test('набор ключей expect должен совпасть с set в обоих режимах', () => {
  assert.equal(patchCardBody.safeParse({ set: { custom: { plan: 'а' } }, expect: { custom: { other: null } } }).success, false);
  assert.equal(patchCardBody.safeParse({ version: 1, set: { custom: { plan: 'а' } }, expect: { custom: {} } }).success, false);
});
