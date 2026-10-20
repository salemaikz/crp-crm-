// Правила пар D-174: каждая строка таблицы дизайна — отдельная проверка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairEffect } from '../../../src/server/domain/distribution/pool';
import type { PartnerCardRow } from '../../../src/server/domain/distribution/repo';

const y = (over: Partial<PartnerCardRow>): PartnerCardRow => ({ id: 'cd-y', clientId: 'cl-y', ownerUserId: null, state: 'new', holdReason: '', ...over });

test('напарник в пуле и готов → двойник при любом статусе пары', () => {
  assert.equal(pairEffect(y({}), 'open'), 'twin');
  assert.equal(pairEffect(y({}), 'distinct'), 'twin');
});

test('напарник в «Не звонить»: пара open → блокировка, distinct → без ограничений', () => {
  assert.equal(pairEffect(y({ state: 'do_not_call', ownerUserId: 'u-1' }), 'open'), 'blocked');
  assert.equal(pairEffect(y({ state: 'do_not_call' }), 'open'), 'blocked');
  assert.equal(pairEffect(y({ state: 'do_not_call', ownerUserId: 'u-1' }), 'distinct'), null);
});

test('у напарника есть владелец и живое состояние → карточка уходит только ему', () => {
  for (const state of ['new', 'retry', 'callback', 'agreed', 'client']) {
    assert.deepEqual(pairEffect(y({ ownerUserId: 'u-1', state }), 'open'), { heldBy: 'u-1' }, state);
    assert.deepEqual(pairEffect(y({ ownerUserId: 'u-1', state }), 'distinct'), { heldBy: 'u-1' }, state);
  }
});

test('напарник без владельца, но с задержкой: пара open → блокировка, distinct → без ограничений', () => {
  assert.equal(pairEffect(y({ holdReason: 'dup_pair' }), 'open'), 'blocked');
  assert.equal(pairEffect(y({ holdReason: 'dup_pair' }), 'distinct'), null);
});

test('напарник закрыт или карточки нет → ограничений нет', () => {
  for (const state of ['not_interested', 'not_target', 'written_off']) {
    assert.equal(pairEffect(y({ state, ownerUserId: 'u-1' }), 'open'), null, state);
    assert.equal(pairEffect(y({ state }), 'open'), null, state);
  }
  assert.equal(pairEffect(undefined, 'open'), null);
});
