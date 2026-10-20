// Ошибки домена раздачи: статусы и тело ответа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISTRIBUTION_HTTP_STATUS, DistributionDomainError, failureBody, isDistributionDomainError } from '../../../src/server/domain/distribution/errors';
import { DISTRIBUTION_ERRORS } from '../../../src/server/domain/distribution/types';

test('у каждого кода есть HTTP-статус: not_participant и dates — 400, остальные — 409', () => {
  for (const code of DISTRIBUTION_ERRORS) assert.equal(DISTRIBUTION_HTTP_STATUS[code], code === 'not_participant' || code === 'dates' ? 400 : 409, code);
});

test('over_cap несёт остаток и лимит, остальные коды — только код', () => {
  const e = new DistributionDomainError('over_cap', { remaining: 3, cap: 40 });
  assert.equal(e.status, 409);
  assert.deepEqual(failureBody(e), { error: 'over_cap', remaining: 3, cap: 40 });
  assert.deepEqual(failureBody(new DistributionDomainError('mode_off')), { error: 'mode_off' });
});

test('isDistributionDomainError узнаёт ошибку и по имени (разные бандлы Next)', () => {
  assert.equal(isDistributionDomainError(new DistributionDomainError('not_working')), true);
  const alien = Object.assign(new Error('x'), { name: 'DistributionDomainError', code: 'mode_off' });
  assert.equal(isDistributionDomainError(alien), true);
  assert.equal(isDistributionDomainError(new Error('x')), false);
});
