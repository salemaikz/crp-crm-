import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phone } from '@crm/core';
import { readPhoneRules, readSecurityPolicy } from '../../../src/server/platform/auth/policy';
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
  assert.equal(p.idleHours, 12, 'простой по умолчанию — 12 ч (D-310)');
  assert.deepEqual(p.loginAttempts, { perPhone: 5, perIp: 50, windowMin: 15 });
});

test('простой сессии (D-310): свой из global.security; меньше 2 ч — раздел не прошёл, умолчания', async () => {
  assert.equal((await readSecurityPolicy(async () => ({ global: { security: { idleHours: 720 } } }))).idleHours, 720);
  assert.deepEqual(await readSecurityPolicy(async () => ({ global: { security: { idleHours: 1 } } })), DEFAULT_SECURITY_POLICY);
});

test('невалидный раздел — умолчания; чужой сбой чтения пробрасывается', async () => {
  const p = await readSecurityPolicy(async () => ({ global: { security: { sessionDays: 9999 } } }));
  assert.deepEqual(p, DEFAULT_SECURITY_POLICY);
  await assert.rejects(readSecurityPolicy(async () => { throw new Error('сбой БД'); }), /сбой БД/);
});

test('правила номеров: нет настроек или раздела — ядро по умолчанию; свои префиксы берутся из global.phone', async () => {
  assert.deepEqual(await readPhoneRules(async () => { throw new ConfigMissingError('нет'); }), phone.DEFAULT_PHONE_RULES);
  assert.deepEqual(await readPhoneRules(async () => ({ global: {} })), phone.DEFAULT_PHONE_RULES);
  assert.deepEqual(await readPhoneRules(async () => ({ global: { phone: { country: 'KZ', mobilePrefixes: ['700'] } } })), phone.DEFAULT_PHONE_RULES);
  const own = { country: 'KZ', mobilePrefixes: ['700'], reviewPrefixes: ['701'], landlinePrefixes: ['71x'] };
  assert.deepEqual(await readPhoneRules(async () => ({ global: { phone: own } })), own);
  await assert.rejects(readPhoneRules(async () => { throw new Error('сбой БД'); }), /сбой БД/);
});
