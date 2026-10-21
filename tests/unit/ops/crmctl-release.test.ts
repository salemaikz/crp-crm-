// install, update и rollback с подписанным пакетом (docs/ops/release-design.md §4, §7, D-315): плохая подпись
// останавливает работу до любого вызова docker и записи в etc/, compose/, state.json; ключи образа и worker проверяются;
// rollback перепроверяет сохранённый манифест и Id образа. Docker подменён фейком, данные синтетические.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../../scripts/crmctl';
import { readState } from '../../../scripts/crmctl/state';
import {
  type Override,
  FOREIGN_KEYS,
  FAKE_RELEASE_KEYS,
  imageId,
  makeFake,
  manifestFor,
  seedInstalled,
  signManifest,
  writePackage,
  writePackageArchive,
  type Fake,
} from './crmctl-fakes';

const FAST = ['--wait-seconds', '1', '--recheck-seconds', '120'];
const INSTALL = ['--domain', 'crm.example.kz', '--admin-phone', '77090000001', '--admin-name', 'Синтетика'];
const exists = (p: string) => readFile(p).then(() => true, () => false);

async function assertUntouched(f: Fake, expectState: string | null): Promise<void> {
  assert.equal(f.calls.length, 0, 'ни одного вызова exec (docker, backup, mv)');
  assert.deepEqual(await readdir(f.dirs.etc), expectState ? ['app.env', 'project.env'] : [], 'etc/ не менялся');
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version ?? null, expectState);
  const pk = await readdir(path.join(f.dirs.lib, 'packages')).catch(() => [] as string[]);
  assert.deepEqual(pk.filter((n) => n.startsWith('.incoming-')), []);
}

test('install: подпись верна — ставится, state хранит sha256 манифеста, ключ и вид проверки', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0');
  assert.equal(await run(['install', archive, ...INSTALL, '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.verified, 'signature');
  assert.equal(st?.current.kid, 'test-fake');
  assert.equal(st?.current.manifestSha256, createHash('sha256').update(JSON.stringify(manifestFor('1.0.0'))).digest('hex'));
  assert.ok(await exists(path.join(f.dirs.lib, 'packages', 'crp-1.0.0', 'manifest.sig')));
  // порядок: подпись раньше первого вызова docker
  assert.match(f.out[0] as string, /Пакет и подпись/);
});

test('install: без подписи, чужая подпись, подмена файла — отказ до действий', async () => {
  for (const mk of [
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.0.0', {}, { sig: false }),
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.0.0', {}, { key: FOREIGN_KEYS.priv }),
    async (f: Fake) => {
      const p = await writePackage(f.dirs.lib, '1.0.0');
      await writeFile(path.join(p, 'images.tar'), 'подмена');
      return p;
    },
    // пакет, подписанный ключом стенда, на бою не признаётся
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.0.0', {}, { key: FOREIGN_KEYS.priv, kid: 'stage-a' }),
  ]) {
    const f = await makeFake();
    assert.equal(await run(['install', await mk(f), ...INSTALL, '--wait-seconds', '1'], f.deps), 1);
    await assertUntouched(f, null);
  }
});

test('install: повторная установка — отказ до любых вызовов', async () => {
  const f = await makeFake();
  assert.equal(await run(['install', await writePackageArchive(f.dirs.lib, '1.0.0'), ...INSTALL, '--wait-seconds', '1'], f.deps), 0);
  f.calls.length = 0;
  assert.equal(await run(['install', await writePackage(f.dirs.lib, '1.0.1'), ...INSTALL, '--wait-seconds', '1'], f.deps), 1);
  assert.match(f.err.join('\n'), /Установка уже выполнена/);
  assert.equal(f.calls.length, 0);
});

test('install: crmctl образа несёт другие ключи релизов, чем манифест — стоп до БД', async () => {
  const f = await makeFake();
  f.server.imageKeys = [...FAKE_RELEASE_KEYS, { kid: 'rel-evil', sha256: 'a'.repeat(64) }];
  assert.equal(await run(['install', await writePackageArchive(f.dirs.lib, '1.0.0'), ...INSTALL, '--wait-seconds', '1'], f.deps), 1);
  assert.match(f.err.join('\n'), /Ключи релизов в crmctl образа/);
  assert.equal(f.compose('up').length, 0);
  assert.equal(await readState(f.deps.paths), null);
});

async function updateSetup(): Promise<Fake> {
  const f = await makeFake();
  await seedInstalled(f, '1.0.0');
  f.calls.length = 0;
  return f;
}

test('update: без подписи, чужая подпись, подмена файла, ключ стенда — отказ, exec не вызывался, state прежний', async () => {
  for (const mk of [
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.1.0', {}, { sig: false }),
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.1.0', {}, { key: FOREIGN_KEYS.priv }),
    (f: Fake) => writePackageArchive(f.dirs.lib, '1.1.0', {}, { key: FOREIGN_KEYS.priv, kid: 'stage-a' }),
    async (f: Fake) => {
      const p = await writePackage(f.dirs.lib, '1.1.0');
      await writeFile(path.join(p, 'compose', 'compose.yaml'), 'services: {evil: {}}\n');
      return p;
    },
  ]) {
    const f = await updateSetup();
    const composeBefore = await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8');
    const etcBefore = await readFile(path.join(f.dirs.etc, 'app.env'), 'utf8');
    assert.equal(await run(['update', await mk(f), ...FAST], f.deps), 1, f.err.join('\n'));
    assert.equal(f.calls.length, 0, 'ни одного вызова exec');
    assert.equal(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), composeBefore);
    assert.equal(await readFile(path.join(f.dirs.etc, 'app.env'), 'utf8'), etcBefore);
    assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
    const pk = await readdir(path.join(f.dirs.lib, 'packages'));
    assert.deepEqual(pk.filter((n) => n.startsWith('.incoming-')), []);
    assert.equal(pk.includes('crp-1.1.0'), false, 'неподписанное не распаковано в packages/');
  }
});

test('update: пакет другого клиента, старше или та же версия — отказ до docker (подпись верна)', async () => {
  for (const [ver, over, re] of [
    ['1.1.0', { customer: 'other' }, /другого клиента/],
    ['0.9.0', {}, /старше установленной/],
    ['1.0.0', {}, /уже установлена/],
  ] as const) {
    const f = await updateSetup();
    assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, ver, over), ...FAST], f.deps), 1);
    assert.match(f.err.join('\n'), re);
    assert.equal(f.calls.length, 0);
  }
});

test('update: подписанный пакет проходит; state хранит данные проверки, прежняя запись уходит в previous', async () => {
  const f = await updateSetup();
  assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, '1.1.0'), ...FAST], f.deps), 0, f.err.join('\n'));
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.verified, 'signature');
  assert.equal(st?.current.manifestSha256, createHash('sha256').update(JSON.stringify(manifestFor('1.1.0'))).digest('hex'));
  assert.equal(st?.previous?.verified, 'signature', 'запись о прежней версии сохранена для rollback');
  assert.ok(st?.previous?.manifestSha256);
});

test('update: ключи релизов в crmctl образа не совпадают с манифестом — стоп до миграций и переключения', async () => {
  const f = await updateSetup();
  f.server.pending = true;
  f.server.imageKeys = FAKE_RELEASE_KEYS.slice(0, 1);
  assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, '1.1.0'), ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /Ключи релизов в crmctl образа/);
  assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 0);
  assert.equal(f.compose('run').filter((c) => !c.args.includes('--status')).length, 0, 'миграции не запускались');
  assert.equal(f.compose('up').length, 0);
  assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
  assert.equal(f.calls.some((c) => c.args[0] === 'cp'), false, 'crmctl на хост не копировался');
});

test('update: время сборки ядра образа не совпадает с манифестом — стоп', async () => {
  const f = await updateSetup();
  f.server.imageWatermark = { customer: 'crp', buildId: 'b', builtAt: 1_790_000_000_001 };
  assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, '1.1.0'), ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /время сборки ядра образа не совпадает/);
  assert.equal(f.compose('up').length, 0);
});

test('update: worker не здоров после переключения — автооткат', async () => {
  const f = await updateSetup();
  f.server.workerUnhealthy.add('1.1.0');
  assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, '1.1.0'), ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /worker: starting после переключения[\s\S]*Автооткат на 1\.0\.0/);
  assert.equal(f.server.running, '1.0.0');
  assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
  assert.equal(f.calls.some((c) => c.args[0] === 'cp' && String(c.args[1]).includes('dist/crmctl.mjs')), false, 'crmctl хоста не менялся');
});

test('update: worker упал через 2 минуты — автооткат', async () => {
  const f = await updateSetup();
  f.server.onSleep = () => f.server.workerUnhealthy.add('1.1.0');
  assert.equal(await run(['update', await writePackageArchive(f.dirs.lib, '1.1.0'), ...FAST], f.deps), 1);
  assert.match(f.err.join('\n'), /worker: starting через 120 с/);
  assert.equal(f.server.running, '1.0.0');
});

// ------------------------------------------------- каталог-пакет: подмена после проверки (Q2a, круг 2)

/**
 * Фейк docker: в момент `docker load` злоумышленник с правом записи в исходный каталог подменяет compose.yaml и
 * images.tar. Ставиться должно содержимое из подписанного манифеста — копия в packages/, а не исходный каталог.
 */
function swapOnLoad(src: { pkg: string }, loaded: string[]): Override {
  return async (cmd, args) => {
    if (cmd !== 'docker' || args[0] !== 'load') return undefined;
    const tar = args[2] as string;
    loaded.push(tar);
    await writeFile(path.join(src.pkg, 'compose', 'compose.yaml'), 'services: {evil: {privileged: true}}\n# EVIL: unsigned\n');
    await writeFile(path.join(src.pkg, 'images.tar'), 'EVIL images');
    // docker читает файл, который ему передали: фиксируем, что именно он получил
    loaded.push(await readFile(tar, 'utf8'));
    return undefined;
  };
}

test('update из каталога: подмена compose.yaml и images.tar во время docker load не попадает в установку', async () => {
  const src = { pkg: '' };
  const loaded: string[] = [];
  const f = await makeFake(swapOnLoad(src, loaded));
  await seedInstalled(f, '1.0.0');
  // пакет лежит в каталоге, куда может писать не-root (домашний каталог оператора)
  src.pkg = await writePackage(await mkdtemp(path.join(tmpdir(), 'crmops-home-')), '1.1.0');
  assert.equal(await run(['update', src.pkg, ...FAST], f.deps), 0, f.err.join('\n'));
  const copy = path.join(f.dirs.lib, 'packages', 'crp-1.1.0');
  assert.equal(loaded[0], path.join(copy, 'images.tar'), 'docker load читает копию в packages/, а не исходный каталог');
  assert.equal(loaded[1], 'images:1.1.0');
  assert.equal(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), '# compose для 1.1.0\n');
  assert.equal(await readFile(path.join(copy, 'compose', 'compose.yaml'), 'utf8'), '# compose для 1.1.0\n');
  assert.ok(await exists(path.join(copy, 'manifest.sig')));
  const pk = await readdir(path.join(f.dirs.lib, 'packages'));
  assert.deepEqual(pk.filter((n) => n.startsWith('.incoming-')), []);
});

test('install из каталога: подмена compose.yaml и images.tar во время docker load не попадает в установку', async () => {
  const src = { pkg: '' };
  const loaded: string[] = [];
  const f = await makeFake(swapOnLoad(src, loaded));
  src.pkg = await writePackage(await mkdtemp(path.join(tmpdir(), 'crmops-home-')), '1.0.0');
  assert.equal(await run(['install', src.pkg, ...INSTALL, '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  // compose копируется до docker load, поэтому подменяем ещё раз и проверяем, что ни тот, ни другой файл не взят из источника
  assert.equal(loaded[0], path.join(f.dirs.lib, 'packages', 'crp-1.0.0', 'images.tar'));
  assert.equal(loaded[1], 'images:1.0.0');
  assert.equal(await readFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), 'utf8'), '# compose для 1.0.0\n');
});

// ---------------------------------------------------------------- rollback

async function twoVersions(over?: Parameters<typeof makeFake>[0]): Promise<Fake> {
  const f = await makeFake(over);
  await seedInstalled(f, '1.1.0', '1.0.0');
  f.calls.length = 0;
  return f;
}
const switchedUp = (f: Fake) => f.compose('up').filter((c) => c.args.includes('app'));
const pdir = (f: Fake, v: string) => path.join(f.dirs.lib, 'packages', `crp-${v}`);

test('rollback: сохранённый манифест и подпись целы — откат идёт, запись о проверке переходит к previous', async () => {
  const f = await twoVersions();
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '1.0.0');
  assert.equal(st?.current.verified, 'signature');
  assert.equal(st?.previous?.version, '1.1.0');
  assert.equal(st?.previous?.verified, 'signature');
  assert.ok(f.calls.some((c) => c.args[0] === 'create'), 'crmctl прежнего образа поставлен на хост (ключи не шире текущих)');
});

test('rollback: подменён Id образа — отказ до переключения', async () => {
  const f = await twoVersions((cmd, args) => {
    if (cmd === 'docker' && args[0] === 'image' && args.includes('--format') && args.at(-1) === 'crm-app:1.0.0') {
      return { code: 0, stdout: `${imageId('evil')}\n`, stderr: '' };
    }
    return undefined;
  });
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 1);
  assert.match(f.err.join('\n'), /Id образа crm-app:1\.0\.0 не совпадает с подписанным/);
  assert.equal(switchedUp(f).length, 0);
  assert.equal((await readState(f.deps.paths))?.current.version, '1.1.0');
});

test('rollback: изменён сохранённый манифест — отказ на бою, на стенде — предупреждение', async () => {
  const f = await twoVersions();
  await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.json'), JSON.stringify(manifestFor('1.0.0', { buildId: 'подмена' })));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 1);
  assert.match(f.err.join('\n'), /Откат на 1\.0\.0 запрещён: сохранённый manifest\.json изменён[\s\S]*crmctl update/);
  assert.equal(switchedUp(f).length, 0);

  const g = await twoVersions();
  await writeFile(path.join(g.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  await writeFile(path.join(pdir(g, '1.0.0'), 'manifest.json'), JSON.stringify(manifestFor('1.0.0', { buildId: 'подмена' })));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], g.deps), 0, g.err.join('\n'));
  assert.match(g.err.join('\n'), /Предупреждение \(стенд\)/);
});

test('rollback: ключ прежней версии отозван (нет в доверенных) — отказ на бою', async () => {
  const f = await twoVersions();
  const bytes = await readFile(path.join(pdir(f, '1.0.0'), 'manifest.json'));
  await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.sig'), signManifest(bytes, FOREIGN_KEYS.priv, 'rel-old'));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 1);
  assert.match(f.err.join('\n'), /ключ rel-old не входит в доверенные/);
  assert.equal(switchedUp(f).length, 0);
});

/** state.json прежнего crmctl (до O4c): у previous нет полей проверки подписи. */
async function legacyPrevious(f: Fake): Promise<void> {
  const st = (await readState(f.deps.paths))!;
  delete st.previous!.manifestSha256;
  delete st.previous!.verified;
  delete st.previous!.kid;
  const { writeState } = await import('../../../scripts/crmctl/state');
  await writeState(f.deps.paths, st);
}

test('rollback на версию до O4c: подписанный manifest.json в packages/ проходит текущими ключами — откат идёт, запись дописана', async () => {
  const f = await twoVersions();
  await legacyPrevious(f);
  const bytes = await readFile(path.join(pdir(f, '1.0.0'), 'manifest.json'));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.match(f.out.join('\n'), /запись о проверке подписи 1\.0\.0 восстановлена/);
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '1.0.0');
  assert.equal(st?.current.manifestSha256, createHash('sha256').update(bytes).digest('hex'), 'manifestSha256 записан задним числом');
  assert.equal(st?.current.verified, 'signature');
  assert.equal(st?.current.kid, 'test-fake');
  // повторный rollback (обратно на 1.1.0) и следующий — на 1.0.0 уже по записи
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal((await readState(f.deps.paths))?.current.version, '1.0.0');
});

test('rollback на версию до O4c: подписанного манифеста нет, подпись чужая или манифест другой сборки — понятный отказ с путём в RUNBOOK', async () => {
  const cases: [string, (f: Fake) => Promise<void>, RegExp][] = [
    ['манифеста нет', async (f) => {
      const { rm } = await import('node:fs/promises');
      await rm(pdir(f, '1.0.0'), { recursive: true, force: true });
    }, /подписанного manifest\.json в .*crp-1\.0\.0 нет/],
    ['подписи нет', async (f) => {
      const { rm } = await import('node:fs/promises');
      await rm(path.join(pdir(f, '1.0.0'), 'manifest.sig'));
    }, /сохранённой подписи нет/],
    ['чужой ключ', async (f) => {
      const bytes = await readFile(path.join(pdir(f, '1.0.0'), 'manifest.json'));
      await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.sig'), signManifest(bytes, FOREIGN_KEYS.priv));
    }, /подпись не сходится/],
    ['другая сборка', async (f) => {
      const bytes = Buffer.from(JSON.stringify(manifestFor('1.0.0', { buildId: 'другая-сборка' })));
      await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.json'), bytes);
      await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.sig'), signManifest(bytes));
    }, /buildId .* не совпадает/],
    ['манифест другой версии', async (f) => {
      const bytes = Buffer.from(JSON.stringify(manifestFor('1.0.1')));
      await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.json'), bytes);
      await writeFile(path.join(pdir(f, '1.0.0'), 'manifest.sig'), signManifest(bytes));
    }, /для другой версии или клиента/],
  ];
  for (const [name, mut, re] of cases) {
    const f = await twoVersions();
    await legacyPrevious(f);
    await mut(f);
    assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 1, name);
    const err = f.err.join('\n');
    assert.match(err, re, name);
    assert.match(err, /Откат на 1\.0\.0 запрещён: версия поставлена до проверки подписи/, name);
    assert.match(err, /RUNBOOK «Откат на версию до O4c»/, name);
    assert.equal(switchedUp(f).length, 0, name);
    assert.equal((await readState(f.deps.paths))?.current.version, '1.1.0', name);
  }
});

test('rollback: подпись сохранённого манифеста подменена на неверную — отказ', async () => {
  const g = await twoVersions();
  await writeFile(path.join(pdir(g, '1.0.0'), 'manifest.sig'), signManifest(Buffer.from('другой манифест')));
  assert.equal(await run(['rollback', '--wait-seconds', '1'], g.deps), 1);
  assert.match(g.err.join('\n'), /подпись не сходится/);
});

test('rollback: crmctl прежней версии с более широким набором ключей на хост не ставится', async () => {
  const f = await twoVersions();
  f.deps.trust.release = { 'rel-test-a': f.deps.trust.release['rel-test-a'] as string }; // у хоста только один ключ из двух
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.match(f.err.join('\n'), /остаётся текущий crmctl/);
  assert.equal(f.calls.some((c) => c.args[0] === 'create'), false);
});
