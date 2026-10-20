// Источник IP клиента в production (D-155): без CRM_PROXY_SECRET — отказ запуска (instrumentation),
// в рантайме — громкое предупреждение не чаще раза в час; вне production — тихо.
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
import { startupConfigProblems } from '../../../src/server/platform/env';
import { register } from '../../../src/instrumentation';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
const SECRET = 'q'.repeat(43); // синтетика
const PROD = { NODE_ENV: 'production' };
const PROD_OK = { ...PROD, APP_ORIGIN: 'https://crm.example.kz', CRM_PROXY_SECRET: SECRET };

afterEach(() => resetClientIpWarning());

async function captureAsyncErrors(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    await fn();
    return lines;
  } finally {
    console.error = orig;
  }
}

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

test('production без секрета прокси — проблема; TRUST_X_REAL_IP и TRUSTED_PROXY_HOPS её не снимают', () => {
  assert.match(clientIpConfigProblem(PROD) ?? '', /не задан CRM_PROXY_SECRET/);
  assert.match(clientIpConfigProblem({ ...PROD, TRUST_X_REAL_IP: '1' }) ?? '', /TRUST_X_REAL_IP=1 больше не действует/);
  assert.notEqual(clientIpConfigProblem({ ...PROD, TRUSTED_PROXY_HOPS: '1' }), null);
  assert.match(clientIpConfigProblem({ ...PROD, CRM_PROXY_SECRET: 'short' }) ?? '', /не того формата/);
  assert.match(clientIpConfigProblem(PROD) ?? '', /crmctl update/);
  assert.equal(clientIpConfigProblem({ ...PROD, CRM_PROXY_SECRET: SECRET }), null);
  assert.equal(clientIpConfigProblem({}), null);
  assert.equal(clientIpConfigProblem({ NODE_ENV: 'test' }), null);
});

test('старт в production: без секрета или без APP_ORIGIN — проблема с понятным текстом; с ними — нет', () => {
  const noSecret = startupConfigProblems({ ...PROD_OK, CRM_PROXY_SECRET: undefined });
  assert.equal(noSecret.length, 1);
  assert.match(noSecret[0] ?? '', /не задан CRM_PROXY_SECRET/);
  const noOrigin = startupConfigProblems({ ...PROD_OK, APP_ORIGIN: undefined });
  assert.equal(noOrigin.length, 1);
  assert.match(noOrigin[0] ?? '', /APP_ORIGIN/);
  assert.equal(startupConfigProblems(PROD).length, 2);
  assert.deepEqual(startupConfigProblems(PROD_OK), []);
  assert.deepEqual(startupConfigProblems({ NODE_ENV: 'development' }), []);
});

test('instrumentation.register: в production без секрета — сообщение и выход с кодом 1; с секретом и на edge — запуск', async () => {
  const saved = { ...process.env };
  const realExit = process.exit;
  const exits: (string | number | null | undefined)[] = [];
  process.exit = ((code?: string | number | null) => {
    exits.push(code);
  }) as typeof process.exit;
  const set = (o: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    set({ NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', APP_ORIGIN: 'https://crm.example.kz', CRM_PROXY_SECRET: undefined });
    const failed = await captureAsyncErrors(() => register());
    assert.deepEqual(exits, [1]);
    assert.match(failed.join('\n'), /Запуск остановлен[\s\S]*CRM_PROXY_SECRET/);
    set({ CRM_PROXY_SECRET: SECRET });
    await register();
    set({ CRM_PROXY_SECRET: undefined, NEXT_RUNTIME: 'edge' });
    await register();
    assert.deepEqual(exits, [1], 'больше выходов нет');
  } finally {
    process.exit = realExit;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
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
});

test('подделанная метка прокси при настроенном секрете — предупреждение раз в час, IP не берётся', () => {
  const env = { ...PROD, CRM_PROXY_SECRET: SECRET };
  const forged = h({ 'x-via-proxy': '1', 'x-real-ip': '203.0.113.9' });
  const first = captureErrors(() => deriveClientIp(forged, env, 1_000));
  assert.equal(first.result, UNKNOWN_IP);
  assert.equal(first.lines.length, 1);
  assert.match(first.lines[0] ?? '', /без верного секрета/);
  assert.ok(!(first.lines[0] ?? '').includes(SECRET), 'секрет не попадает в лог');
  assert.equal(captureErrors(() => deriveClientIp(forged, env, 2_000)).lines.length, 0);
  // прямой запрос без меток (источник лидов, проверка здоровья) — тихо
  assert.equal(captureErrors(() => deriveClientIp(h({}), env, 3_000)).lines.length, 0);
  const ok = captureErrors(() => deriveClientIp(h({ 'x-proxy-secret': SECRET, 'x-real-ip': '203.0.113.9' }), env));
  assert.equal(ok.result, '203.0.113.9');
  assert.equal(ok.lines.length, 0);
});

test('образец app.env, nginx и CONFIG §7 описывают секрет прокси', () => {
  const env = readFileSync(join(ROOT, 'deploy', 'compose', 'app.env.example'), 'utf8');
  assert.match(env, /^CRM_PROXY_SECRET=$/m);
  assert.doesNotMatch(env, /^TRUST_X_REAL_IP=/m);
  const nginx = readFileSync(join(ROOT, 'deploy', 'nginx', 'crm.conf.template'), 'utf8');
  assert.match(nginx, /proxy_set_header X-Real-IP \$remote_addr;/);
  const config = readFileSync(join(ROOT, 'docs', 'CONFIG.md'), 'utf8');
  const s7 = config.slice(config.indexOf('## 7.'), config.indexOf('## 8.'));
  assert.match(s7, /`CRM_PROXY_SECRET`/);
});

test('e2e на собранном приложении (production) задаёт APP_ORIGIN и синтетический CRM_PROXY_SECRET', () => {
  const pw = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
  assert.match(pw, /APP_ORIGIN: `http:\/\/localhost:\$\{PORT\}`/);
  assert.match(pw, /CRM_PROXY_SECRET:/);
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'e2e.yml'), 'utf8');
  assert.match(wf, /^\s+APP_ORIGIN: http:\/\/localhost:3100$/m);
  const secret = /^\s+CRM_PROXY_SECRET: (\S+)$/m.exec(wf)?.[1] ?? '';
  assert.equal(startupConfigProblems({ NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3100', CRM_PROXY_SECRET: secret }).length, 0);
});
