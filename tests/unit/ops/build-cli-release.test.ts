// Сборка crmctl с ключами релизов (docs/ops/release-design.md §3, §4.5, D-315): клиентская сборка вшивает только rel-*
// и не содержит заглушки CRM_VERIFY_STUB; без ключей, с stage-*/test-* или битым ключом падает.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '@crm/core';
import { REL_A, REL_B, makeKeyPair, writePackage } from './crmctl-fakes';

const EXPORTS = Object.keys(core).join(',');
const build = (outdir: string, extra: string[]) =>
  spawnSync(process.execPath, ['scripts/crmctl/build-cli.mjs', '--outdir', outdir, '--only', 'crmctl', '--core-exports', EXPORTS, ...extra], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });

async function keysFile(dir: string, keys: Record<string, string>): Promise<string> {
  const f = path.join(dir, 'release-keys.json');
  await writeFile(f, JSON.stringify(keys));
  return f;
}

test('клиентская сборка: ключи вшиты, строки CRM_VERIFY_STUB в файле нет; общая сборка её содержит', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-rel-'));
  try {
    const keys = await keysFile(dir, { 'rel-2026a': REL_A.pub, 'rel-2026b': REL_B.pub });
    const client = build(path.join(dir, 'client'), ['--customer', 'demo-co', '--release-keys', keys]);
    assert.equal(client.status, 0, client.stderr);
    const text = await readFile(path.join(dir, 'client', 'crmctl.mjs'), 'utf8');
    assert.equal(text.includes('CRM_VERIFY_STUB'), false, 'в клиентском crmctl нет ветки заглушки');
    assert.ok(text.includes(REL_A.pub) && text.includes(REL_B.pub), 'открытые ключи вшиты');

    const general = build(path.join(dir, 'general'), []);
    assert.equal(general.status, 0, general.stderr);
    assert.ok((await readFile(path.join(dir, 'general', 'crmctl.mjs'), 'utf8')).includes('CRM_VERIFY_STUB'));

    // вшитые ключи видны через `crmctl keys --json`
    const out = spawnSync(process.execPath, [path.join(dir, 'client', 'crmctl.mjs'), 'keys', '--json'], { encoding: 'utf8', cwd: dir });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual((JSON.parse(out.stdout) as { release: { kid: string }[] }).release.map((k) => k.kid), ['rel-2026a', 'rel-2026b']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('заглушка не работает в собранном клиентском crmctl даже на стенде с CRM_VERIFY_STUB=allow; в общей сборке — работает', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-rel-'));
  try {
    const keys = await keysFile(dir, { 'rel-2026a': REL_A.pub });
    assert.equal(build(path.join(dir, 'client'), ['--customer', 'demo-co', '--release-keys', keys]).status, 0);
    assert.equal(build(path.join(dir, 'general'), []).status, 0);
    const etc = path.join(dir, 'etc');
    await mkdir(etc);
    await writeFile(path.join(etc, 'app.env'), 'CRM_STAND=1\n');
    const pkg = await writePackage(dir, '1.0.0', {}, { sig: false });
    const env = { ...process.env, CRM_VERIFY_STUB: 'allow', CRM_ETC_DIR: etc, CRM_LIB_DIR: path.join(dir, 'lib') };
    const verify = (which: string) =>
      spawnSync(process.execPath, [path.join(dir, which, 'crmctl.mjs'), 'package', 'verify', pkg], { encoding: 'utf8', cwd: dir, env });
    const c = verify('client');
    assert.equal(c.status, 1);
    assert.match(c.stderr, /Нет файла подписи/);
    const g = verify('general');
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /ПОДПИСЬ НЕ ПРОВЕРЕНА/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('сборка падает: клиент без ключей, пустой набор, stage-*, test-*, битый ключ', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-rel-'));
  try {
    const noKeys = build(path.join(dir, 'a'), ['--customer', 'demo-co']);
    assert.equal(noKeys.status, 1);
    assert.match(noKeys.stderr, /нужен непустой --release-keys/);
    const cases: [Record<string, string>, RegExp][] = [
      [{}, /нужен непустой --release-keys/],
      [{ 'stage-a': makeKeyPair().pub }, /не класса rel-\*/],
      [{ 'test-a': makeKeyPair().pub }, /не класса rel-\*/],
      [{ 'rel-a': makeKeyPair().pub, 'stage-b': makeKeyPair().pub }, /не класса rel-\*/],
      [{ 'rel-a': 'AAAA' }, /32 байта/],
      [{ 'rel-a': REL_A.pub.slice(0, -2) }, /32 байта/],
    ];
    for (const [keys, re] of cases) {
      const r = build(path.join(dir, 'b'), ['--customer', 'demo-co', '--release-keys', await keysFile(dir, keys)]);
      assert.equal(r.status, 1, JSON.stringify(keys));
      assert.match(r.stderr, re);
    }
    // ключи не rel-* не принимаются и в общей сборке
    const general = build(path.join(dir, 'c'), ['--release-keys', await keysFile(dir, { 'stage-a': makeKeyPair().pub })]);
    assert.equal(general.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
