import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSecurityPolicy } from '../../../src/server/platform/auth/policy';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';

class ConfigMissingError extends Error {
  override name = 'ConfigMissingError';
}

test('настройки не применены — значения по умолчанию', async () => {
  const p = await readSecurityPolicy(async () => { throw new ConfigMissingError('нет'); });
  assert.deepEqual(p, DEFAULT_SECURITY_POLICY);
});

test('частичный раздел global.security дополняется умолчаниями', async () => {
  const p = await readSecurityPolicy(async () => ({ global: { security: { sessionDays: 7, loginAttempts: { perIp: 50 } } } }));
  assert.equal(p.sessionDays, 7);
  assert.equal(p.inviteTtlHours, 72);
  assert.deepEqual(p.loginAttempts, { perPhone: 5, perIp: 50, windowMin: 15 });
});

test('невалидный раздел — умолчания; чужой сбой чтения пробрасывается', async () => {
  const p = await readSecurityPolicy(async () => ({ global: { security: { sessionDays: 9999 } } }));
  assert.deepEqual(p, DEFAULT_SECURITY_POLICY);
  await assert.rejects(readSecurityPolicy(async () => { throw new Error('сбой БД'); }), /сбой БД/);
});
