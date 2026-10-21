// Среда выполнения сборки клиента (D-312): предзагрузка (--require/--import/--loader), инспектор (--inspect, SIGUSR1)
// и LD_PRELOAD подменяют проверку лицензии без правки кода. Сборка клиента такой запуск не начинает: приложение
// (instrumentation) и воркер выходят с кодом 1. Общая сборка (стенд, CI, e2e с предзагрузкой ядра) не проверяется.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeTamperProblems, type RuntimeFacts } from '../../../src/server/platform/license/runtime';
import { overrideLicenseEnvForTests, resetLicenseEnvForTests } from '../../../src/server/platform/license/testing';
import { register } from '../../../src/instrumentation';
import { runWorkerProcess } from '../../../scripts/worker/run';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CLEAN: RuntimeFacts = {
  customerBuild: true,
  execArgv: ['--disable-sigusr1'],
  env: { NODE_OPTIONS: '--max-old-space-size=1024' },
  inspectorUrl: undefined,
};
const facts = (patch: Partial<RuntimeFacts>): RuntimeFacts => ({ ...CLEAN, ...patch });

afterEach(() => resetLicenseEnvForTests());

test('сборка клиента: запуск как в поставке — без замечаний', () => {
  assert.deepEqual(runtimeTamperProblems(CLEAN), []);
  assert.deepEqual(runtimeTamperProblems(facts({ execArgv: [], env: { NODE_OPTIONS: '--disable-sigusr1 --max-old-space-size=384' } })), []);
  assert.deepEqual(runtimeTamperProblems(facts({ env: {} })), []);
});

test('сборка клиента: предзагрузка и загрузчики в NODE_OPTIONS и в аргументах node — отказ', () => {
  const bad = [
    '--require /tmp/patch.cjs',
    '-r /tmp/patch.cjs',
    '--require=/tmp/patch.cjs',
    '--import=/tmp/patch.mjs',
    '--import /tmp/patch.mjs',
    '--loader /tmp/l.mjs',
    '--experimental-loader=/tmp/l.mjs',
    '--max-old-space-size=1024 --require "/tmp/a b.cjs"',
    '--inspect',
    '--inspect=0.0.0.0:9229',
    '--inspect-brk',
    '--inspect-port=9229',
    '--max-old-space-size=1024x',
  ];
  for (const opts of bad) {
    assert.ok(runtimeTamperProblems(facts({ env: { NODE_OPTIONS: opts } })).length > 0, `NODE_OPTIONS=${opts}`);
    assert.ok(runtimeTamperProblems(facts({ execArgv: ['--disable-sigusr1', ...opts.split(' ')] })).length > 0, `node ${opts}`);
  }
});

test('сборка клиента: без --disable-sigusr1 — отказ (инспектор открывается сигналом)', () => {
  const p = runtimeTamperProblems(facts({ execArgv: [] }));
  assert.equal(p.length, 1);
  assert.match(p[0] ?? '', /--disable-sigusr1/);
});

test('сборка клиента: LD_PRELOAD и открытый инспектор — отказ', () => {
  assert.ok(runtimeTamperProblems(facts({ env: { LD_PRELOAD: '/tmp/x.so' } })).some((s) => /LD_PRELOAD/.test(s)));
  assert.ok(runtimeTamperProblems(facts({ inspectorUrl: 'ws://127.0.0.1:9229/x' })).some((s) => /инспектор/.test(s)));
  assert.deepEqual(runtimeTamperProblems(facts({ env: { LD_PRELOAD: '  ' } })), []);
});

test('сообщение называет флаг, но не повторяет путь к подгружаемому файлу', () => {
  const p = runtimeTamperProblems(facts({ env: { NODE_OPTIONS: '--require=/srv/secret-dir/patch.cjs' } }));
  assert.ok(p.some((s) => s.includes('--require')));
  assert.ok(!p.join('\n').includes('secret-dir'));
});

test('общая сборка (без водяного знака клиента): не проверяется — стенд, CI и e2e с предзагрузкой ядра работают', () => {
  assert.deepEqual(
    runtimeTamperProblems({ customerBuild: false, execArgv: ['--inspect'], env: { NODE_OPTIONS: '--require x.cjs', LD_PRELOAD: 'y' }, inspectorUrl: 'ws://x' }),
    [],
  );
});

const WATERMARK_CUSTOMER = { customer: 'acme-synthetic', buildId: 'b-1', builtAt: 1_700_000_000_000 };

async function withExitAndEnv(env: Record<string, string | undefined>, fn: (exits: unknown[], errors: string[]) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const realExit = process.exit;
  const realError = console.error;
  const exits: unknown[] = [];
  const errors: string[] = [];
  process.exit = ((code?: unknown) => {
    exits.push(code);
  }) as typeof process.exit;
  console.error = (...a: unknown[]) => errors.push(a.join(' '));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn(exits, errors);
  } finally {
    process.exit = realExit;
    console.error = realError;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('instrumentation.register: сборка клиента с предзагрузкой — сообщение license.runtime_tamper и выход с кодом 1', async () => {
  overrideLicenseEnvForTests({ watermark: WATERMARK_CUSTOMER });
  await withExitAndEnv(
    { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', APP_ORIGIN: 'https://crm.example.kz', CRM_PROXY_SECRET: 'q'.repeat(43), NODE_OPTIONS: '--require /tmp/p.cjs' },
    async (exits, errors) => {
      await register();
      assert.deepEqual(exits, [1]);
      assert.match(errors.join('\n'), /license\.runtime_tamper[\s\S]*--require/);
    },
  );
});

test('instrumentation.register: общая сборка с той же предзагрузкой — запуск', async () => {
  await withExitAndEnv(
    { NODE_ENV: 'production', NEXT_RUNTIME: 'nodejs', APP_ORIGIN: 'https://crm.example.kz', CRM_PROXY_SECRET: 'q'.repeat(43), NODE_OPTIONS: '--require /tmp/p.cjs' },
    async (exits) => {
      await register();
      assert.deepEqual(exits, []);
    },
  );
});

test('воркер: сборка клиента с предзагрузкой — отказ до открытия БД', async () => {
  overrideLicenseEnvForTests({ watermark: WATERMARK_CUSTOMER });
  await withExitAndEnv({ NODE_OPTIONS: '--import /tmp/p.mjs', DATABASE_URL: undefined }, async (_exits, errors) => {
    await assert.rejects(runWorkerProcess(), /runtime_tamper/);
    assert.match(errors.join('\n'), /license\.runtime_tamper/);
  });
});

test('поставка: app и worker запускаются с --disable-sigusr1 (Dockerfile и compose)', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^CMD \["node", "--disable-sigusr1", "server\.js"\]$/m);
  const compose = readFileSync(join(ROOT, 'deploy', 'compose', 'compose.yaml'), 'utf8');
  assert.match(compose, /command: \["node", "--disable-sigusr1", "server\.js"\]/);
  assert.match(compose, /command: \["node", "--disable-sigusr1", "dist\/worker\.mjs"\]/);
  // В NODE_OPTIONS поставки — только флаги из белого списка
  for (const m of compose.matchAll(/NODE_OPTIONS: (.+)$/gm)) {
    assert.deepEqual(runtimeTamperProblems(facts({ env: { NODE_OPTIONS: m[1] } })), [], m[1]);
  }
});
