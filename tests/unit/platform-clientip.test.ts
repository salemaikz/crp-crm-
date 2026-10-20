import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_IP, deriveClientIp, trustedProxyHops } from '../../src/server/platform/http/clientIp';

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

test('без доверенных прокси заголовки не читаются', () => {
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }), {}), UNKNOWN_IP);
});

test('N прокси: берётся N-е значение справа, левее — подделка клиента', () => {
  const env = { TRUSTED_PROXY_HOPS: '1' };
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }), env), '203.0.113.9');
  assert.equal(deriveClientIp(h({}), env), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': 'не-ip' }), env), UNKNOWN_IP);
});

test('X-Real-IP только при TRUST_X_REAL_IP=1', () => {
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), { TRUST_X_REAL_IP: '1' }), '203.0.113.7');
});

test('TRUSTED_PROXY_HOPS: только целое 0..20', () => {
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' }), 2);
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: '99' }), 0);
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'x' }), 0);
});
