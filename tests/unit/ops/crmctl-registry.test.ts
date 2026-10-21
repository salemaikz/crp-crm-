// Реестр crmctl: команда license зарегистрирована, справка её описывает, проверка лицензии при update —
// настоящая (ядро нового образа), а не заглушка (P10, D-211).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USAGE, commands, defaultDeps, rawCommands, run } from '../../../scripts/crmctl';

test('license в реестре и в справке', () => {
  assert.equal(typeof commands.license, 'function');
  assert.match(USAGE, /license …\s+лицензия: install <файл> \| status/);
});

test('crmctl license без подкоманды — справка и код 2', async () => {
  const err: string[] = [];
  const deps = { ...defaultDeps({}), io: { out: () => {}, err: (l: string) => err.push(l) } };
  assert.equal(await run(['license'], deps), 2);
  assert.match(err.join('\n'), /license install <файл> \| status/);
});

test('verifyLicense в defaultDeps не заглушка: идёт к состоянию установки, а не отвечает «не реализована»', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reg-'));
  try {
    const deps = defaultDeps({ CRM_ETC_DIR: path.join(dir, 'etc'), CRM_LIB_DIR: path.join(dir, 'lib') });
    await assert.rejects(
      deps.verifier.verifyLicense({ image: 'crm-app:9.9.9', licenseDir: path.join(dir, 'lib/license'), installId: 'x' }),
      (e: Error) => !/не реализована/.test(e.message),
    );
    // подпись пакета — не заглушка: без файла подписи пакет не принимается (verify.ts, O4c)
    assert.equal(typeof deps.trust.release, 'object');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Красная команда, круг 4: RUNBOOK и DEPLOY называли `crmctl license-clock reset --yes` единственным выходом из
// блокировки «часы позади» после спешивших часов, а команды в реестре не было (код 2, «Неизвестная команда»).
// Тест идёт через index.ts (run), а не через runLicenseClock: проверяется разводка команды.
test('license-clock в реестре и в справке; run() доходит до команды, а не до «Неизвестная команда»', async () => {
  assert.equal(typeof rawCommands['license-clock'], 'function');
  assert.match(USAGE, /license-clock …\s+.*status \| reset --yes/);
  const err: string[] = [];
  const consoleErr: string[] = [];
  const deps = { ...defaultDeps({}), io: { out: () => {}, err: (l: string) => err.push(l) } };
  const orig = console.error;
  const savedDb = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // отказ без --yes обязан случиться до открытия БД
  console.error = (...a: unknown[]) => void consoleErr.push(a.map(String).join(' '));
  try {
    assert.equal(await run(['license-clock', 'reset'], deps), 2);
    assert.equal(await run(['license-clock'], deps), 2);
  } finally {
    console.error = orig;
    if (savedDb !== undefined) process.env.DATABASE_URL = savedDb;
  }
  assert.doesNotMatch(err.join('\n'), /Неизвестная команда/);
  assert.match(consoleErr.join('\n'), /license\.clock_reset/, 'отказ сброса без --yes — от самой команды');
  assert.match(consoleErr.join('\n'), /crmctl license-clock status/, 'справка команды');
});

test('каждая команда crmctl, которую называют RUNBOOK и DEPLOY, есть в реестре', async () => {
  const docs = (await Promise.all(['docs/ops/RUNBOOK.md', 'docs/DEPLOY.md'].map((p) => readFile(p, 'utf8')))).join('\n');
  const named = new Set([...docs.matchAll(/crmctl ([a-z][a-z-]*)/g)].map((m) => m[1] as string));
  assert.ok(named.has('license-clock') && named.has('update'), 'документы читаются');
  const missing = [...named].filter((c) => !commands[c] && !rawCommands[c]);
  assert.deepEqual(missing, [], 'операторские документы обещают незарегистрированные команды');
});

// Q2a, круг 2: комментарии в коде лицензии называли `crmctl license clock-reset`, а такой подкоманды нет — оператор,
// взявший имя из кода, получал справку и код 2. Подкоманды license и license-clock сверяются с тем, что разбирают
// scripts/crmctl/license.ts и license-clock.ts, во всём коде и операторских документах.
test('подкоманды crmctl license и license-clock, названные в коде и документах, существуют', async () => {
  const files: string[] = ['docs/ops/RUNBOOK.md', 'docs/DEPLOY.md', 'docs/ARCHITECTURE.md'];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(p);
    }
  };
  await walk('src');
  await walk('scripts');
  const text = (await Promise.all(files.map((p) => readFile(p, 'utf8')))).join('\n');
  const parsed = async (p: string) => new Set([...(await readFile(p, 'utf8')).matchAll(/sub === '([a-z-]+)'/g)].map((m) => m[1] as string));
  const known: Record<string, Set<string>> = {
    license: await parsed('scripts/crmctl/license.ts'),
    'license-clock': await parsed('scripts/crmctl/license-clock.ts'),
  };
  assert.ok(known.license!.has('install') && known['license-clock']!.has('reset'), 'разбор подкоманд найден');
  const bad = [...text.matchAll(/crmctl (license(?:-clock)?) ([a-z][a-z-]*)/g)]
    .filter((m) => !known[m[1] as string]!.has(m[2] as string))
    .map((m) => m[0]);
  assert.deepEqual([...new Set(bad)], [], 'названы несуществующие подкоманды');
});
