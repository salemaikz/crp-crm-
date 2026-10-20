// Сборка точек входа образа (scripts/crmctl/build-cli.mjs, D-101) и флаги ключей лицензий в build.mjs (D-211).
// crmctl и воркер не вшивают исходник ядра, а берут @crm/core из образа; клиентская сборка ядра без ключей падает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '@crm/core';

const run = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: process.cwd() });
const KEY = 'tW3RIfHgQEA86ddaG5bkfbGdcHTeADZt8khVP8s+5LI=';

test('dist/crmctl.mjs и worker.mjs: ядро внешнее, исходника ядра в файле нет', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-'));
  try {
    const r = run('scripts/crmctl/build-cli.mjs', ['--outdir', dir, '--only', 'crmctl,worker', '--core-exports', Object.keys(core).join(',')]);
    assert.equal(r.status, 0, r.stderr);
    // Строки, которые есть только в исходнике ядра (проверка лицензии и ключей): в минифицированном бандле остались бы
    const markers = ['license keys: ожидается объект kid → ключ', 'license keys: недопустимый kid'];
    for (const name of ['crmctl', 'worker']) {
      const text = await readFile(path.join(dir, `${name}.mjs`), 'utf8');
      for (const m of markers) assert.ok(!text.includes(m), `${name}.mjs содержит исходник ядра: ${m}`);
      assert.ok(!text.includes('tW3RIfHgQEA86ddaG5bkfbGdcHTeADZt8khVP8s+5LI='), `${name}.mjs содержит тестовый ключ ядра`);
      assert.match(text, /\("@crm\/core"\)/, `${name}.mjs должен брать ядро из образа`);
    }
    // ядро нужно только лениво: список экспортов совпадает с ядром (namespace-объекты)
    const crmctl = await readFile(path.join(dir, 'crmctl.mjs'), 'utf8');
    assert.ok(crmctl.includes('Proxy'), 'прокладка ядра ленивая');
    // Хостовая копия живёт без ядра и без node_modules: справка и команды без ядра работают, а в бандле
    // не срабатывают «автозапуски» отдельных модулей (backup.ts и др.), которые перехватывали любую команду
    const help = spawnSync(process.execPath, [path.join(dir, 'crmctl.mjs'), 'help'], { encoding: 'utf8', cwd: dir });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /crmctl — сопровождение установки CRM/);
    assert.match(help.stdout, /license …/);
    const unknown = spawnSync(process.execPath, [path.join(dir, 'crmctl.mjs'), 'nope'], { encoding: 'utf8', cwd: dir });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Неизвестная команда: nope/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build.mjs: сборка клиента без --license-keys — ошибка', () => {
  const r = run('packages/core/build.mjs', ['--customer', 'demo-co', '--build-id', 'b-1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--license-keys обязателен вместе с --customer/);
});

test('build.mjs: ключи клиента проверяются — тестовый kid, битый ключ, пустой набор', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'keys-'));
  try {
    const cases: Array<[unknown, RegExp]> = [
      [{ 'test-1': KEY }, /тестовый ключ test-1 в сборке клиента запрещён/],
      [{ 'prod-1': 'не-ключ' }, /ключ prod-1 — не 32 байта base64/],
      [{}, /пустой набор/],
      [['x'], /ожидается объект/],
    ];
    for (const [i, [doc, re]] of cases.entries()) {
      const f = path.join(dir, `k${i}.json`);
      await writeFile(f, JSON.stringify(doc));
      const r = run('packages/core/build.mjs', ['--customer', 'demo-co', '--build-id', 'b-1', '--license-keys', f]);
      assert.equal(r.status, 1, `случай ${i}`);
      assert.match(r.stderr, re, `случай ${i}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
