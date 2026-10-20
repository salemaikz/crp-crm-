// IP клиента и доверенный прокси по секрету (D-155): заголовки nginx читаются только с верным X-Proxy-Secret.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_IP, deriveClientIp, resetClientIpWarning, trustedProxyHops } from '../../src/server/platform/http/clientIp';
import { classifyRequest, ingestReachable, proxySecret, secretsEqual } from '../../src/server/platform/http/trustedProxy';

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const SECRET = 'A'.repeat(20) + 'b_-'.repeat(8); // 44 символа base64url, синтетика
const ENV = { CRM_PROXY_SECRET: SECRET };
const viaNginx = (o: Record<string, string> = {}) => h({ 'x-proxy-secret': SECRET, 'x-via-proxy': '1', ...o });

afterEach(() => resetClientIpWarning());

test('без секрета в env заголовки прокси не читаются', () => {
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' }), {}), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-proxy-secret': SECRET }), {}), UNKNOWN_IP);
});

test('с верным секретом — X-Real-IP от nginx', () => {
  assert.equal(deriveClientIp(viaNginx({ 'x-real-ip': '203.0.113.7' }), ENV), '203.0.113.7');
  assert.equal(deriveClientIp(viaNginx({ 'x-real-ip': '[2001:db8::1]:443' }), ENV), '2001:db8::1');
  assert.equal(deriveClientIp(viaNginx({ 'x-real-ip': 'не-ip' }), ENV), UNKNOWN_IP);
});

test('без секрета или с неверным — IP не подделать (прямой запрос из crm_ingest)', () => {
  const quiet = { ...ENV, NODE_ENV: 'test' };
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-via-proxy': '1' }), quiet), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-proxy-secret': SECRET.slice(1) }), quiet), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-proxy-secret': `${SECRET}x` }), quiet), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7', 'x-proxy-secret': '' }), quiet), UNKNOWN_IP);
  // TRUST_X_REAL_IP больше ничего не включает
  assert.equal(deriveClientIp(h({ 'x-real-ip': '203.0.113.7' }), { TRUST_X_REAL_IP: '1' }), UNKNOWN_IP);
});

test('N прокси: N-е значение X-Forwarded-For справа и только с верным секретом', () => {
  const env = { ...ENV, TRUSTED_PROXY_HOPS: '1' };
  assert.equal(deriveClientIp(viaNginx({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }), env), '203.0.113.9');
  assert.equal(deriveClientIp(viaNginx(), env), UNKNOWN_IP);
  assert.equal(deriveClientIp(viaNginx({ 'x-forwarded-for': 'не-ip' }), env), UNKNOWN_IP);
  assert.equal(deriveClientIp(h({ 'x-forwarded-for': '203.0.113.9' }), { TRUSTED_PROXY_HOPS: '1' }), UNKNOWN_IP);
});

test('TRUSTED_PROXY_HOPS: только целое 0..20', () => {
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2' }), 2);
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: '99' }), 0);
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: 'x' }), 0);
});

test('секрет: только base64url от 32 символов, иначе как не задан', () => {
  assert.equal(proxySecret(ENV), SECRET);
  assert.equal(proxySecret({ CRM_PROXY_SECRET: ` ${SECRET} ` }), SECRET);
  assert.equal(proxySecret({ CRM_PROXY_SECRET: 'короткий' }), null);
  assert.equal(proxySecret({ CRM_PROXY_SECRET: 'a'.repeat(31) }), null);
  assert.equal(proxySecret({ CRM_PROXY_SECRET: `${'a'.repeat(32)}"; x` }), null);
  assert.equal(proxySecret({}), null);
  assert.equal(secretsEqual(SECRET, SECRET), true);
  assert.equal(secretsEqual(SECRET.slice(0, -1), SECRET), false);
  assert.equal(secretsEqual('', SECRET), false);
});

test('классификация и второй рубеж /api/ingest: внешний — только с секретом, подделка — никогда', () => {
  assert.equal(classifyRequest(viaNginx(), ENV), 'proxy');
  assert.equal(classifyRequest(h({}), ENV), 'direct');
  assert.equal(classifyRequest(h({ 'x-via-proxy': '1' }), ENV), 'forged');
  assert.equal(classifyRequest(h({ 'x-proxy-secret': 'x'.repeat(43) }), ENV), 'forged');
  assert.equal(classifyRequest(viaNginx(), {}), 'forged', 'секрета в env нет — метке не верим');
  // INGEST_PUBLIC=0: снаружи закрыто, внутренний источник проходит, подделка не проходит
  assert.equal(ingestReachable(viaNginx(), { ...ENV, INGEST_PUBLIC: '0' }), false);
  assert.equal(ingestReachable(h({}), { ...ENV, INGEST_PUBLIC: '0' }), true);
  assert.equal(ingestReachable(h({ 'x-via-proxy': '1' }), { ...ENV, INGEST_PUBLIC: '0' }), false);
  // INGEST_PUBLIC=1: снаружи открыто, но поддельная метка всё равно закрыта
  assert.equal(ingestReachable(viaNginx(), { ...ENV, INGEST_PUBLIC: '1' }), true);
  assert.equal(ingestReachable(h({ 'x-via-proxy': '1' }), { ...ENV, INGEST_PUBLIC: '1' }), false);
});
