// Среда выполнения сборки клиента (D-312): предзагрузка (--require/--import/--loader), инспектор (--inspect, SIGUSR1)
// и LD_PRELOAD подменяют проверку лицензии без правки кода. Сборка клиента такой запуск не начинает: приложение
// (instrumentation) и воркер выходят с кодом 1. Общая сборка (стенд, CI, e2e с предзагрузкой ядра) не проверяется.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_ENTRY, runtimeTamperProblems, type RuntimeFacts } from '../../../src/server/platform/license/runtime';
import { overrideLicenseEnvForTests, resetLicenseEnvForTests } from '../../../src/server/platform/license/testing';
import { register } from '../../../src/instrumentation';
import { runWorkerProcess } from '../../../scripts/worker/run';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const CLEAN: RuntimeFacts = {
  customerBuild: true,
  role: 'app',
  entry: '/app/server.js',
  mainModule: '/app/server.js',
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
    runtimeTamperProblems({
      customerBuild: false,
      role: 'app',
      entry: '-',
      mainModule: undefined,
      execArgv: ['--inspect'],
      env: { NODE_OPTIONS: '--require x.cjs', LD_PRELOAD: 'y', LD_AUDIT: 'z' },
      inspectorUrl: 'ws://x',
    }),
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

// ── Обёртка входа (круг 1 раунда 4 волны B): sh -c 'printf … | exec node --disable-sigusr1 -' или /tmp/w.js ────────

test('сборка клиента: точка входа не из поставки (stdin, -e, скрипт в /tmp) — отказ; app и worker — свои пути', () => {
  for (const entry of ['-', undefined, '/tmp/w.js', '/app/dist/worker.mjs']) {
    const p = runtimeTamperProblems(facts({ entry, mainModule: undefined }));
    assert.ok(p.some((x) => /точка входа/.test(x)), `app, вход ${String(entry)}`);
    assert.ok(!p.join('\n').includes('/tmp/w.js'), 'путь чужого скрипта в сообщение не попадает');
  }
  // Главный модуль CommonJS — тоже вход поставки: обёртка, подменившая только process.argv, не проходит
  assert.ok(runtimeTamperProblems(facts({ mainModule: '/tmp/w.js' })).some((x) => /точка входа/.test(x)));
  assert.deepEqual(runtimeTamperProblems(facts({ role: 'worker', entry: '/app/dist/worker.mjs', mainModule: undefined })), []);
  assert.ok(runtimeTamperProblems(facts({ role: 'worker', entry: '/app/server.js', mainModule: undefined })).length > 0);
  assert.deepEqual(RUNTIME_ENTRY, { app: '/app/server.js', worker: '/app/dist/worker.mjs' });
});

test('сборка клиента: переменные загрузчика и подгрузки кода (LD_AUDIT, LD_LIBRARY_PATH, OPENSSL_CONF, NODE_PATH…) — отказ', () => {
  for (const name of ['LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'GCONV_PATH', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES']) {
    const p = runtimeTamperProblems(facts({ env: { NODE_OPTIONS: '--max-old-space-size=1024', [name]: '/tmp/x' } }));
    assert.ok(p.some((x) => x.includes(name)), name);
    assert.ok(!p.join('\n').includes('/tmp/x'), `${name}: значение в сообщение не попадает`);
  }
});

test('живая проба: node --disable-sigusr1 со скриптом из stdin и из /tmp — вход виден как чужой', () => {
  const runtimeTs = join(ROOT, 'src', 'server', 'platform', 'license', 'runtime.ts');
  const probe = [
    `import { currentRuntimeFacts, runtimeTamperProblems } from ${JSON.stringify(runtimeTs)};`,
    `const f = { ...currentRuntimeFacts('app'), customerBuild: true, execArgv: ['--disable-sigusr1'], env: {} };`,
    `process.stdout.write(JSON.stringify({ entry: f.entry ?? null, problems: runtimeTamperProblems(f) }));`,
  ].join('\n');
  const run = (args: string[], input?: string) =>
    JSON.parse(execFileSync(process.execPath, ['--disable-sigusr1', '--import', 'tsx', ...args], { cwd: ROOT, input, encoding: 'utf8' })) as {
      entry: string | null;
      problems: string[];
    };
  const fromStdin = run(['--input-type=module', '-'], probe);
  assert.notEqual(fromStdin.entry, '/app/server.js');
  assert.ok(fromStdin.problems.some((x) => /точка входа/.test(x)), JSON.stringify(fromStdin));
  const dir = mkdtempSync(join(tmpdir(), 'crm-entry-'));
  try {
    const script = join(dir, 'w.mts');
    writeFileSync(script, probe);
    const fromTmp = run([script]);
    assert.ok(fromTmp.entry?.endsWith('/w.mts'), JSON.stringify(fromTmp));
    assert.ok(fromTmp.problems.some((x) => /точка входа/.test(x)), JSON.stringify(fromTmp));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('поставка: /tmp и кэш Next в контейнерах app и worker — tmpfs с noexec (.so для LD_AUDIT оттуда не грузится)', () => {
  const compose = readFileSync(join(ROOT, 'deploy', 'compose', 'compose.yaml'), 'utf8');
  for (const m of compose.matchAll(/^\s+- (\/tmp|\/app\/\.next\/cache):(.+)$/gm)) {
    const opts = m[2]!.split(',');
    for (const o of ['noexec', 'nosuid', 'nodev']) assert.ok(opts.includes(o), `${m[1]}: ${o}`);
  }
  assert.match(compose, /- \/tmp:[^\n]*noexec/);
});
