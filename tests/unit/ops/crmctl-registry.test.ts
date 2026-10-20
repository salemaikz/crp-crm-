// Реестр crmctl: команда license зарегистрирована, справка её описывает, проверка лицензии при update —
// настоящая (ядро нового образа), а не заглушка (P10, D-211).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USAGE, commands, defaultDeps, run } from '../../../scripts/crmctl';

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
    // а проверка подписи пакета остаётся заглушкой до O4c
    const pkg = await deps.verifier.verifyPackage({ dir, manifest: {} as never });
    assert.equal(pkg.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
