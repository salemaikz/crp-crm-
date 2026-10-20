#!/usr/bin/env node
// Сборка ядра @crm/core для поставки (D-028, решение K0 — D-101):
// esbuild (один файл CJS, без карт) → javascript-obfuscator → packages/core/dist/index.cjs.
// В dev и тестах ядро берётся из исходников (tsconfig paths); dist нужен только production-сборке Next.
//
//   node packages/core/build.mjs                   общая сборка (водяной знак «unset»)
//   node packages/core/build.mjs --customer <клиент> --build-id <id>   сборка ядра клиента (слой образа)
//   node packages/core/build.mjs --check           + проверки: нет карт и путей, экспорт совпадает,
//                                                  тесты ядра и тест-векторы на обфусцированной сборке
//   node packages/core/build.mjs --no-obfuscate    только esbuild + минификация (диагностика, запасной вариант)
//
// Только локальная обфускация: облачные (pro) режимы javascript-obfuscator не используем — код ядра не
// уходит во внешние сервисы.
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const CORE = dirname(fileURLToPath(import.meta.url));
const SRC = join(CORE, 'src');
const DIST = join(CORE, 'dist');
const ENTRY = join(SRC, 'index.ts');
const OUT = join(DIST, 'index.cjs');

const { values: args } = parseArgs({
  options: {
    customer: { type: 'string', default: process.env.CRM_CUSTOMER_ID ?? 'unset' },
    'build-id': { type: 'string', default: process.env.CRM_BUILD_ID ?? 'unset' },
    check: { type: 'boolean', default: false },
    'no-obfuscate': { type: 'boolean', default: false },
  },
});

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
for (const k of ['customer', 'build-id']) {
  if (!ID_RE.test(args[k])) fail(`--${k}: только [a-z0-9._-], до 64 символов`);
}

// Внешние зависимости ядра: только zod (D-011) и встроенные модули — их не бандлим и не обфусцируем.
const EXTERNAL = ['zod', 'node:*'];

// Водяной знак: ядро читает константы через `typeof __CRM_BUILD_ID__ !== 'undefined'` (в dev их нет).
const define = {
  __CRM_CUSTOMER_ID__: JSON.stringify(args.customer),
  __CRM_BUILD_ID__: JSON.stringify(args['build-id']),
};

/**
 * Настройки обфускатора. Не ломают работу: без self-defending и debug-protection (ломаются от
 * минификации и отладчика), без dead code injection (размер), без тяжёлого шифрования строк.
 * renameGlobals безопасен: CJS-модуль — своя область видимости, require/module/exports не объявлены в нём.
 * seed фиксирован — одинаковый вход даёт одинаковый файл (воспроизводимость digest пакета).
 */
export const OBFUSCATOR_OPTIONS = {
  target: 'node',
  seed: 20261021,
  compact: true,
  simplify: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: true,
  renameProperties: false,
  transformObjectKeys: false,
  stringArray: true,
  stringArrayThreshold: 0.5,
  stringArrayEncoding: [],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: 'variable',
  splitStrings: false,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: false,
  numbersToExpressions: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  sourceMap: false,
};

function fail(msg) {
  console.error(`core build: ${msg}`);
  process.exit(1);
}

/** esbuild → один файл JS в памяти. */
async function bundle(entry, { format = 'cjs', external = EXTERNAL } = {}) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node22',
    format,
    external,
    define,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    minify: true,
    keepNames: false,
    logLevel: 'error',
  });
  return res.outputFiles[0].text;
}

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
}

async function buildCore() {
  const t0 = performance.now();
  const plain = await bundle(ENTRY);
  const t1 = performance.now();
  const code = args['no-obfuscate'] ? plain : obfuscate(plain);
  const t2 = performance.now();
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  writeFileSync(OUT, code);
  const kb = (n) => `${(n / 1024).toFixed(1)} КБ`;
  console.log(
    `core build: ${relative(process.cwd(), OUT)} · esbuild ${(t1 - t0).toFixed(0)} мс · ` +
      `обфускация ${args['no-obfuscate'] ? 'выкл' : `${(t2 - t1).toFixed(0)} мс`} · ` +
      `${kb(plain.length)} → ${kb(code.length)} (gzip ${kb(gzipSync(code).length)}) · ` +
      `клиент ${args.customer}, сборка ${args['build-id']}`,
  );
  return { plain, code };
}

// ---------- Проверки (--check) ----------

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Признаки того, что в артефакт утекли исходники или карты. */
function leaks(code) {
  const out = [];
  if (/sourceMappingURL/.test(code)) out.push('sourceMappingURL');
  if (/packages\/core\/src|\.ts["'`]/.test(code)) out.push('пути исходников');
  if (/\n\s*\/\/ /.test(code)) out.push('комментарии');
  return out;
}

const requireCjs = createRequire(import.meta.url);

/** Загрузить CJS-код из временного файла (рядом с ядром, чтобы резолвился zod). */
function load(code, tag) {
  const file = join(DIST, `.check-${tag}.cjs`);
  writeFileSync(file, code);
  try {
    return requireCjs(file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Сравнить экспорт: ключи, типы; данные — глубоко; функции — по арности. */
function compareExports(a, b, where) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) fail(`${where}: экспорт различается: ${ka} ≠ ${kb}`);
  for (const k of ka) {
    if (typeof a[k] !== typeof b[k]) fail(`${where}: тип ${k} различается`);
    if (typeof a[k] === 'function') {
      if (a[k].length !== b[k].length) fail(`${where}: арность ${k} различается`);
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      fail(`${where}: значение ${k} различается после обфускации`);
    }
  }
  return ka.length;
}

async function check({ plain, code }) {
  const problems = leaks(code);
  if (problems.length) fail(`в dist: ${problems.join(', ')}`);
  if (readdirSync(DIST).some((n) => n.endsWith('.map'))) fail('в dist есть .map');
  const n = compareExports(load(plain, 'plain'), load(code, 'obf'), 'index');
  console.log(`check: dist без карт и путей; экспорт index совпадает (${n})`);

  // Тест-векторы обзвона: много данных и вспомогательных функций — смоук обфускатора на реальном коде.
  const vectors = join(SRC, 'calling/spec/vectors.ts');
  try {
    statSync(vectors);
    const vp = await bundle(vectors);
    const m = compareExports(load(vp, 'vplain'), load(obfuscate(vp), 'vobf'), 'calling/spec/vectors');
    console.log(`check: calling/spec/vectors — ${m} экспортов совпадают после обфускации`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Юнит-тесты ядра: каждый *.test.ts собирается вместе с кодом ядра тем же esbuild + обфускатором
  // и запускается node --test. Так тесты проверяют обфусцированный код, а не исходник.
  const tests = walk(SRC).filter((p) => p.endsWith('.test.ts'));
  if (!tests.length) {
    console.log('check: тестов ядра нет (*.test.ts) — пропуск');
    return;
  }
  // Внутри dist: оттуда ESM-импорт zod находит node_modules репозитория (NODE_PATH для ESM не работает)
  const tmp = join(DIST, '.check-tests');
  mkdirSync(tmp, { recursive: true });
  try {
    const files = [];
    for (const t of tests) {
      const js = await bundle(t, { format: 'esm', external: [...EXTERNAL, 'node:test', 'node:assert'] });
      const out = join(tmp, relative(SRC, t).replaceAll('/', '__').replace(/\.ts$/, '.mjs'));
      writeFileSync(out, obfuscate(js));
      files.push(out);
    }
    const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
    if (r.status !== 0) fail('тесты ядра падают на обфусцированной сборке');
    console.log(`check: ${files.length} файлов тестов ядра зелёные на обфусцированной сборке`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const res = await buildCore();
if (args.check) {
  await check(res);
  const srcKb = walk(SRC)
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .reduce((s, p) => s + readFileSync(p).length, 0) / 1024;
  console.log(`check: исходники ядра ${srcKb.toFixed(1)} КБ .ts`);
}
