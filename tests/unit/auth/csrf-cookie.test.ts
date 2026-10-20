import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrigin, originCheckRequired } from '../../../src/server/platform/auth/csrf';
import { sessionCookieSpec } from '../../../src/server/platform/auth/cookie';
import { inviteLink } from '../../../src/server/platform/auth/invites';
import { loginPhoneDigits, maskPhone } from '../../../src/server/platform/auth/login';

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const env = { APP_ORIGIN: 'https://crm.example.test' };

test('checkOrigin: нет, null, другой порт и схема, хвостовой слэш, верный', () => {
  assert.equal(checkOrigin(h({}), env), 'missing');
  assert.equal(checkOrigin(h({ origin: 'null' }), env), 'missing');
  assert.equal(checkOrigin(h({ origin: 'https://evil.test' }), env), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'https://crm.example.test:8443' }), env), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'http://crm.example.test' }), env), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'https://crm.example.test/' }), env), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'https://crm.example.test' }), env), 'ok');
  assert.equal(checkOrigin(h({ origin: 'https://crm.example.test' }), { APP_ORIGIN: 'https://crm.example.test/' }), 'ok');
});

test('checkOrigin: Sec-Fetch-Site', () => {
  const base = { origin: 'https://crm.example.test' };
  assert.equal(checkOrigin(h({ ...base, 'sec-fetch-site': 'same-origin' }), env), 'ok');
  assert.equal(checkOrigin(h({ ...base, 'sec-fetch-site': 'none' }), env), 'ok');
  assert.equal(checkOrigin(h({ ...base, 'sec-fetch-site': 'cross-site' }), env), 'cross_site');
  assert.equal(checkOrigin(h({ ...base, 'sec-fetch-site': 'same-site' }), env), 'cross_site');
});

test('checkOrigin: без APP_ORIGIN в production — отказ, вне production — по Host', () => {
  assert.equal(checkOrigin(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }), { NODE_ENV: 'production' }), 'mismatch');
  assert.equal(checkOrigin(h({ origin: 'http://localhost:3000', host: 'localhost:3000' }), {}), 'ok');
});

test('originCheckRequired: GET нет, POST да, машинные входы нет', () => {
  assert.equal(originCheckRequired('GET', '/api/x'), false);
  assert.equal(originCheckRequired('HEAD', '/'), false);
  assert.equal(originCheckRequired('POST', '/api/auth/login'), true);
  assert.equal(originCheckRequired('post', '/leads'), true);
  assert.equal(originCheckRequired('POST', '/api/ingest/lead'), false);
  assert.equal(originCheckRequired('POST', '/api/hooks/wazzup'), false);
  assert.equal(originCheckRequired('DELETE', '/api/ingestor'), true);
});

test('sessionCookieSpec: https — __Host- и Secure; localhost по http — без; production с http — ошибка', () => {
  assert.deepEqual(sessionCookieSpec({ APP_ORIGIN: 'https://crm.example.test' }), {
    name: '__Host-crm_sid', httpOnly: true, secure: true, sameSite: 'lax', path: '/',
  });
  const local = sessionCookieSpec({ APP_ORIGIN: 'http://localhost:3100', NODE_ENV: 'production' });
  assert.equal(local.name, 'crm_sid');
  assert.equal(local.secure, false);
  assert.throws(() => sessionCookieSpec({ APP_ORIGIN: 'http://crm.example.test', NODE_ENV: 'production' }));
  assert.throws(() => sessionCookieSpec({ NODE_ENV: 'production' }));
  assert.equal(sessionCookieSpec({}).name, 'crm_sid');
});

test('inviteLink: токен во фрагменте, без query', () => {
  const link = inviteLink('abc_DEF-123', env);
  assert.equal(link, 'https://crm.example.test/invite#abc_DEF-123');
  assert.ok(link.includes('#') && !link.includes('?'));
  assert.throws(() => inviteLink('t', { NODE_ENV: 'production' }));
});

test('loginPhoneDigits и maskPhone', () => {
  assert.equal(loginPhoneDigits('8 (701) 555-01-23'), '77015550123');
  assert.equal(loginPhoneDigits('+7 701 555 01 23'), '77015550123');
  assert.equal(loginPhoneDigits('701 555 01 23'), '77015550123');
  assert.equal(loginPhoneDigits('abc'), null);
  assert.equal(loginPhoneDigits('12345'), null);
  assert.equal(loginPhoneDigits('+1 701 555 01 23'), null);
  assert.equal(loginPhoneDigits('7'.repeat(40)), null);
  assert.equal(maskPhone('77015550123'), '+7 701 ••• •• 23');
  assert.ok(!maskPhone('77015550123').includes('555'));
});
