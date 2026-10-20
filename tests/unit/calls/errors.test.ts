// Ошибки домена обзвона → HTTP (docs/calls-design.md §11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CallsDomainError, httpFailure } from '../../../src/server/domain/calls/errors';

test('не найдено и повторное использование opId — один и тот же 404', () => {
  assert.deepEqual(httpFailure(new CallsDomainError('not_found')), { kind: 'not_found' });
  assert.deepEqual(httpFailure(new CallsDomainError('opid_reused')), { kind: 'not_found' });
});

test('проверки шторки → 400 с кодом и полем', () => {
  for (const code of ['reason_required', 'lpr_required', 'callback_in_past', 'phone_required', 'outcome_archived', 'field_not_allowed', 'phone_not_on_card', 'fields'] as const) {
    assert.deepEqual(httpFailure(new CallsDomainError(code, 'x')), { kind: 'response', status: 400, body: { error: 'bad_request', code, field: 'x' } }, code);
  }
});

test('skip_limit несёт лимит, invalid_transition — 409', () => {
  assert.deepEqual(httpFailure(new CallsDomainError('skip_limit', null, { skipLimit: 10 })), { kind: 'response', status: 409, body: { error: 'skip_limit', skipLimit: 10 } });
  assert.equal((httpFailure(new CallsDomainError('invalid_transition')) as { status: number }).status, 409);
});

test('forbidden → 403 обёрткой; прочие отказы ядра → 409 conflict', () => {
  assert.deepEqual(httpFailure(new CallsDomainError('forbidden')), { kind: 'forbidden' });
  assert.deepEqual(httpFailure(new CallsDomainError('version_conflict')), { kind: 'response', status: 409, body: { error: 'conflict', code: 'version_conflict' } });
});
