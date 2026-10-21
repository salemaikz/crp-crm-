#!/usr/bin/env node
// Сборка точек входа образа: dist/{migrate,crmctl,worker}.mjs (Dockerfile, ARCHITECTURE §8.2, D-101).
// Один минифицированный ESM-файл на каждую, без исходников и карт. Ядро @crm/core в них НЕ вшивается:
// оно берётся из образа (обфусцированный packages/core/dist/index.cjs с водяным знаком и ключами лицензий
// клиента). Иначе проверка лицензии в crmctl и воркере шла бы по исходнику ядра, а не по ядру образа.
//
//   node scripts/crmctl/build-cli.mjs [--outdir dist] [--only crmctl,worker] [--core-exports a,b,c]
//                                     [--customer <клиент> --release-keys <keys.json>]
//
// Клиентская сборка (--customer) вшивает в crmctl открытые ключи релизов (D-315, §3): JSON { "rel-…": "<ключ
// Ed25519 base64>" } из BuildKit-секрета release_keys, и вырезает из него заглушку CRM_VERIFY_STUB. Без ключей, а также
// с ключами не класса `rel-*` (stage-*, test-*) сборка падает: crmctl без ключей не принял бы ни одного пакета.
//
// Именованный импорт из обфусцированного CJS в Node не работает (cjs-module-lexer не видит экспорт),
// поэтому @crm/core подменяется тонкой прокладкой: каждый экспорт — ленивая обёртка над require('@crm/core')
// в момент первого обращения. Хост-копия dist/crmctl.mjs (deploy/install.sh берёт её из образа) запускается
// без ядра: команды, которым оно нужно, исполняются в образе, а на хосте обращения к ядру не происходит.
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const CORE = '@crm/core';
const SHIM_NS = 'crm-core-shim';

export const ENTRIES = [
  { src: 'scripts/db-migrate.ts', out: 'migrate', required: true },
  { src: 'scripts/crmctl/index.ts', out: 'crmctl', required: false },
  { src: 'scripts/worker/index.ts', out: 'worker', required: false },
];

/** Исходник прокладки: имена экспортов ядра известны на этапе сборки. */
export function shimSource(names) {
  const lines = names.map((n) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(n)) throw new Error(`экспорт ядра с недопустимым именем: ${n}`);
    return `export const ${n} = lazy(${JSON.stringify(n)});`;
  });
  return [
    'let core;',
    `const load = () => (core ??= require(${JSON.stringify(CORE)}));`,
    'const lazy = (name) => new Proxy({}, { get: (_t, key) => load()[name][key], has: (_t, key) => key in load()[name] });',
    ...lines,
  ].join('\n');
}

export function corePlugin(names) {
  return {
    name: 'crm-core-external',
    setup(b) {
      b.onResolve({ filter: /^@crm\/core(\/.*)?$/ }, (a) => {
        // Сам require внутри прокладки — внешний (ядро образа)
        if (a.namespace === SHIM_NS) return { path: CORE, external: true };
        if (a.path !== CORE) {
          return { errors: [{ text: `${a.path}: импортируйте ядро только как '${CORE}' (D-101)` }] };
        }
        return { path: CORE, namespace: SHIM_NS };
      });
      b.onLoad({ filter: /.*/, namespace: SHIM_NS }, () => ({ contents: shimSource(names), loader: 'js', resolveDir: process.cwd() }));
    },
  };
}

/** Ключи релизов: kid `rel-*` → сырой ключ Ed25519 (32 байта) в base64. Любое отклонение — исключение. */
export function parseReleaseKeys(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('release keys: не JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('release keys: ожидается объект kid → ключ');
  const out = {};
  for (const [kid, b64] of Object.entries(obj)) {
    if (!/^rel-[A-Za-z0-9._-]{1,40}$/.test(kid)) throw new Error(`release keys: kid ${kid} не класса rel-* (ключи stage-* и test-* в клиентскую сборку не входят)`);
    const raw = typeof b64 === 'string' ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
    if (raw.length !== 32 || raw.toString('base64') !== b64) throw new Error(`release keys: ключ ${kid} должен быть 32 байта Ed25519 в base64`);
    out[kid] = b64;
  }
  return out;
}

export async function buildCli({ outdir, only, coreExports, customer, releaseKeysFile, cwd = process.cwd() }) {
  let releaseKeys = {};
  if (releaseKeysFile) releaseKeys = parseReleaseKeys(readFileSync(releaseKeysFile, 'utf8'));
  if (customer && Object.keys(releaseKeys).length === 0) {
    throw new Error('release keys: для клиентской сборки (--customer) нужен непустой --release-keys');
  }
  const names =
    coreExports ?? Object.keys(createRequire(join(cwd, 'noop.js'))(CORE));
  if (names.length === 0) throw new Error('у ядра нет экспортов: собран ли packages/core/dist?');
  const built = [];
  for (const e of ENTRIES) {
    if (only && !only.includes(e.out)) continue;
    if (!existsSync(resolve(cwd, e.src))) {
      if (e.required) throw new Error(`нет ${e.src}`);
      console.log(`пропуск ${e.out}: нет ${e.src}`);
      continue;
    }
    await build({
      entryPoints: [resolve(cwd, e.src)],
      outfile: resolve(cwd, outdir, `${e.out}.mjs`),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      charset: 'utf8',
      logLevel: 'error',
      tsconfig: resolve(cwd, 'tsconfig.json'),
      banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
      define: {
        __CRM_CLIENT_BUILD__: customer ? 'true' : 'false',
        __CRM_CUSTOMER__: JSON.stringify(customer ?? ''),
        __CRM_RELEASE_KEYS__: JSON.stringify(JSON.stringify(releaseKeys)),
      },
      plugins: [corePlugin(names)],
    });
    built.push(e.out);
  }
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({
    options: {
      outdir: { type: 'string', default: 'dist' },
      only: { type: 'string' },
      'core-exports': { type: 'string' },
      customer: { type: 'string' },
      'release-keys': { type: 'string' },
    },
  });
  const built = await buildCli({
    outdir: values.outdir,
    only: values.only?.split(','),
    coreExports: values['core-exports']?.split(','),
    customer: values.customer || undefined,
    releaseKeysFile: values['release-keys'],
  });
  console.log(`build-cli: ${built.join(', ')}`);
}
