// Реестр crmctl: команда license зарегистрирована, справка её описывает, проверка лицензии при update —
// настоящая (ядро нового образа), а не заглушка (P10, D-211).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
