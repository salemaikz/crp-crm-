// Источник IP клиента в production (D-152): без TRUST_X_REAL_IP/TRUSTED_PROXY_HOPS — громкое
// предупреждение не чаще раза в час; вне production — тихо.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNKNOWN_IP,
  clientIpConfigProblem,
  deriveClientIp,
  resetClientIpWarning,
  warnClientIpConfig,
} from '../../../src/server/platform/http/clientIp';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const PROD = { NODE_ENV: 'production' };

afterEach(() => resetClientIpWarning());

function captureErrors<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = orig;
  }
}

test('production без доверенного источника IP — проблема; с TRUST_X_REAL_IP=1 или прокси — нет', () => {
  assert.match(clientIpConfigProblem(PROD) ?? '', /TRUST_X_REAL_IP=1/);
  assert.equal(clientIpConfigProblem({ ...PROD, TRUST_X_REAL_IP: '1' }), null);
  assert.equal(clientIpConfigProblem({ ...PROD, TRUSTED_PROXY_HOPS: '1' }), null);
  assert.equal(clientIpConfigProblem({ ...PROD, TRUST_X_REAL_IP: 'yes' }) !== null, true);
  assert.equal(clientIpConfigProblem({}), null);
  assert.equal(clientIpConfigProblem({ NODE_ENV: 'test' }), null);
});

test('предупреждение громкое и не чаще раза в час; вне production — тишина', () => {
  const first = captureErrors(() => deriveClientIp(h({ 'x-real-ip': '203.0.113.9' }), PROD));
  assert.equal(first.result, UNKNOWN_IP);
  assert.equal(first.lines.length, 1);
  assert.match(first.lines[0] ?? '', /^\[security\] ВНИМАНИЕ/);
  const again = captureErrors(() => warnClientIpConfig(PROD, Date.now() + 60_000));
  assert.equal(again.result, false);
  assert.equal(again.lines.length, 0);
  const hourLater = captureErrors(() => warnClientIpConfig(PROD, Date.now() + 61 * 60_000));
  assert.equal(hourLater.result, true);
  resetClientIpWarning();
  assert.equal(captureErrors(() => deriveClientIp(h({}), {})).lines.length, 0);
  assert.equal(captureErrors(() => deriveClientIp(h({ 'x-real-ip': '203.0.113.9' }), { ...PROD, TRUST_X_REAL_IP: '1' })).result, '203.0.113.9');
});

test('образец app.env установки доверяет X-Real-IP nginx, CONFIG §7 описывает переменную', () => {
  const env = readFileSync(join(ROOT, 'deploy', 'compose', 'app.env.example'), 'utf8');
  assert.match(env, /^TRUST_X_REAL_IP=1$/m);
  const nginx = readFileSync(join(ROOT, 'deploy', 'nginx', 'crm.conf.template'), 'utf8');
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/);
  const config = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  const s7 = config.slice(config.indexOf('## 7.'), config.indexOf('## 8.'));
  assert.match(s7, /`TRUST_X_REAL_IP`/);
});
