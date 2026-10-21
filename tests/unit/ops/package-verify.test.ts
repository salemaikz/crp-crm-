// Проверка подписи и распаковка пакета (docs/ops/release-design.md §3, §4.1, §7). Ключи создаются на лету,
// docker подменён фейком: каждый отказ не должен сделать ни одного вызова exec и не оставить .incoming-*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, sign as edSign } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../../scripts/crmctl';
import { writeArchive } from '../../../scripts/crmctl/package-format';
import { verifyAndUnpack } from '../../../scripts/crmctl/verify';
import {
  FAKE_RELEASE_KEYS,
  FOREIGN_KEYS,
  REL_A,
  TEST_KEYS,
  fileBodies,
  makeFake,
  makeKeyPair,
  manifestFor,
  signManifest,
  writePackage,
  writePackageArchive,
  type Fake,
} from './crmctl-fakes';
import { encodeSigFile, keyFingerprint, signingBytes } from '../../../scripts/crmctl/package-format';

const packagesDir = (f: Fake) => path.join(f.dirs.lib, 'packages');
const leftovers = async (f: Fake) => (await readdir(packagesDir(f)).catch(() => [] as string[])).filter((n) => n.startsWith('.incoming-'));

async function rejected(f: Fake, pkg: string, re: RegExp, opts: { sig?: string } = {}): Promise<void> {
  await assert.rejects(verifyAndUnpack(f.deps, pkg, { write: true, ...opts }), re);
  assert.equal(f.calls.length, 0, 'ни одного вызова exec');
  assert.deepEqual(await leftovers(f), [], '.incoming-* удалён');
  assert.equal((await readdir(packagesDir(f)).catch(() => [] as string[])).length, 0, 'ничего не распаковано');
}

test('верная подпись: архив распакован в packages/<клиент>-<версия> вместе с manifest.sig, exec не вызывался', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0');
  const v = await verifyAndUnpack(f.deps, archive, { write: true });
  assert.equal(v.verified, 'signature');
  assert.equal(v.kid, 'test-fake');
  assert.equal(v.dir, path.join(packagesDir(f), 'crp-1.0.0'));
  assert.equal(await readFile(path.join(v.dir, 'images.tar'), 'utf8'), 'images:1.0.0');
  assert.match(await readFile(path.join(v.dir, 'manifest.sig'), 'utf8'), /"kid":"test-fake"/);
  assert.equal(createHash('sha256').update(await readFile(path.join(v.dir, 'manifest.json'))).digest('hex'), v.manifestSha256);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await leftovers(f), []);
});

test('write=false (package verify): ничего не пишется на диск', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0');
  await verifyAndUnpack(f.deps, archive, { write: false });
  assert.deepEqual(await readdir(f.dirs.lib), ['crm-crp-1.0.0.manifest.sig', 'crm-crp-1.0.0.tar.zst']);
});

test('ключ релиза rel-* (вшитый) принимается на бою', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0', {}, { key: REL_A.priv, kid: 'rel-test-a' });
  const v = await verifyAndUnpack(f.deps, archive, { write: false });
  assert.equal(v.kid, 'rel-test-a');
});

test('отказ: изменён байт манифеста после подписи', async () => {
  const f = await makeFake();
  // подпись остаётся от прежнего манифеста, а в архиве лежит другой (buildId иной)
  const sigOf = signManifest(Buffer.from(JSON.stringify(manifestFor('1.0.0'))));
  const other = await writePackageArchive(f.dirs.lib, '1.0.1', { version: '1.0.1' }, { sig: false });
  await writeFile(other.replace(/\.tar\.zst$/, '.manifest.sig'), sigOf);
  await rejected(f, other, /подпись не сходится/);
});

test('отказ: подпись без префикса crm-release-v1', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0', {}, { sig: false });
  const bytes = Buffer.from(JSON.stringify(manifestFor('1.0.0')));
  await writeFile(archive.replace(/\.tar\.zst$/, '.manifest.sig'), encodeSigFile('test-fake', edSign(null, bytes, TEST_KEYS.priv)));
  await rejected(f, archive, /подпись не сходится/);
});

test('отказ: неизвестный kid и чужой ключ под известным kid', async () => {
  const f = await makeFake();
  await rejected(f, await writePackageArchive(f.dirs.lib, '1.0.0', {}, { kid: 'test-unknown' }), /ключ test-unknown не входит в доверенные/);
  const g = await makeFake();
  await rejected(g, await writePackageArchive(g.dirs.lib, '1.0.0', {}, { key: FOREIGN_KEYS.priv }), /подпись не сходится/);
});

test('отказ: файла подписи нет', async () => {
  const f = await makeFake();
  await rejected(f, await writePackageArchive(f.dirs.lib, '1.0.0', {}, { sig: false }), /Нет файла подписи/);
});

test('--sig: подпись берётся из указанного файла', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0', {}, { sig: false });
  const sig = path.join(f.dirs.lib, 'custom.sig');
  await writeFile(sig, signManifest(Buffer.from(JSON.stringify(manifestFor('1.0.0')))));
  assert.equal((await verifyAndUnpack(f.deps, archive, { write: false, sig })).kid, 'test-fake');
  await assert.rejects(verifyAndUnpack(f.deps, archive, { write: false, sig: path.join(f.dirs.lib, 'нет.sig') }), /Файла подписи нет/);
});

test('ключи стенда: stage-* принимается только при CRM_STAND=1, rel-* из stage-keys.json не признаётся', async () => {
  const stage = makeKeyPair();
  const mk = async () => {
    const f = await makeFake();
    await writeFile(path.join(f.dirs.etc, 'stage-keys.json'), JSON.stringify({ 'stage-a': stage.pub, 'rel-fake': stage.pub }));
    return f;
  };
  const f = await mk();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0', {}, { key: stage.priv, kid: 'stage-a' });
  await rejected(f, archive, /ключ stage-a не входит в доверенные/);
  // стенд: признак в app.env
  const g = await mk();
  await writeFile(path.join(g.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  const a2 = await writePackageArchive(g.dirs.lib, '1.0.0', {}, { key: stage.priv, kid: 'stage-a' });
  assert.equal((await verifyAndUnpack(g.deps, a2, { write: false })).kid, 'stage-a');
  // rel-* из файла стенда — нет, даже на стенде
  const h = await mk();
  await writeFile(path.join(h.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  const a3 = await writePackageArchive(h.dirs.lib, '1.0.0', {}, { key: stage.priv, kid: 'rel-fake' });
  await rejected(h, a3, /ключ rel-fake не входит в доверенные/);
  // CRM_STAND=10 — не признак
  const i = await mk();
  await writeFile(path.join(i.dirs.etc, 'app.env'), 'CRM_STAND=10\n');
  await rejected(i, await writePackageArchive(i.dirs.lib, '1.0.0', {}, { key: stage.priv, kid: 'stage-a' }), /не входит в доверенные/);
});

/** Архив с произвольным составом: манифест подписан как положено, ломается только содержимое. */
async function custom(f: Fake, mutate: (files: Map<string, Buffer>, m: ReturnType<typeof manifestFor>) => void): Promise<string> {
  const files = fileBodies('1.0.0');
  const m = manifestFor('1.0.0');
  mutate(files, m);
  const bytes = Buffer.from(JSON.stringify(m));
  const out = path.join(f.dirs.lib, `c-${Math.random().toString(36).slice(2)}.tar.zst`);
  await writeArchive(out, [{ path: 'manifest.json', kind: 'file', data: bytes }, ...[...files].map(([p, data]) => ({ path: p, kind: 'file' as const, data }))], m.builtAt);
  await writeFile(out.replace(/\.tar\.zst$/, '.manifest.sig'), encodeSigFile('test-fake', edSign(null, signingBytes(bytes), TEST_KEYS.priv)));
  return out;
}

test('отказ: лишний, отсутствующий, изменённый файл и неверный размер', async () => {
  const cases: [string, (files: Map<string, Buffer>, m: ReturnType<typeof manifestFor>) => void, RegExp][] = [
    ['лишний файл', (files) => files.set('extra.sh', Buffer.from('x')), /вне manifest\.json: extra\.sh/],
    ['файл отсутствует', (files) => files.delete('images.tar'), /нет файла из manifest\.json: images\.tar/],
    ['файл изменён', (files) => files.set('images.tar', Buffer.from('images:6.6.6')), /sha256 файла images\.tar/],
    ['размер не тот', (_f, m) => void (m.files[0]!.size += 1), /размер .* не совпадает/],
  ];
  for (const [name, mut, re] of cases) {
    const f = await makeFake();
    await rejected(f, await custom(f, mut), re).catch((e) => {
      throw new Error(`${name}: ${(e as Error).message}`);
    });
  }
});

test('каталог пакета: верный проходит; ссылка, подмена и лишний файл отвергаются', async () => {
  const f = await makeFake();
  const pkg = await writePackage(f.dirs.lib, '1.0.0');
  // только проверка: ничего не копируется
  await verifyAndUnpack(f.deps, pkg, { write: false });
  assert.equal((await readdir(packagesDir(f)).catch(() => [])).length, 0, 'write=false ничего не пишет');
  // установка: каталог обрабатывается как архив — копия в packages/<клиент>-<версия>, дальше работают только с ней
  const v = await verifyAndUnpack(f.deps, pkg, { write: true });
  assert.equal(v.verified, 'signature');
  assert.equal(f.calls.length, 0);
  assert.equal(v.dir, path.join(packagesDir(f), 'crp-1.0.0'));
  assert.deepEqual((await readdir(packagesDir(f))).sort(), ['crp-1.0.0']);
  assert.deepEqual((await readdir(v.dir)).sort(), ['compose', 'images.tar', 'manifest.json', 'manifest.sig']);
  assert.equal(createHash('sha256').update(await readFile(path.join(v.dir, 'manifest.json'))).digest('hex'), v.manifestSha256);
  // правка исходного каталога после проверки не меняет копию
  await writeFile(path.join(pkg, 'images.tar'), 'подмена после проверки');
  assert.equal(await readFile(path.join(v.dir, 'images.tar'), 'utf8'), 'images:1.0.0');

  await symlink('/etc/passwd', path.join(pkg, 'link'));
  await assert.rejects(verifyAndUnpack(f.deps, pkg, { write: true }), /ссылка: link/);
  const g = await makeFake();
  const p2 = await writePackage(g.dirs.lib, '1.0.0');
  await writeFile(path.join(p2, 'images.tar'), 'подмена');
  await assert.rejects(verifyAndUnpack(g.deps, p2, { write: true }), /не совпадает с manifest/);
  const h = await makeFake();
  const p3 = await writePackage(h.dirs.lib, '1.0.0');
  await mkdir(path.join(p3, 'x'));
  await writeFile(path.join(p3, 'x', 'evil.sh'), '#');
  await assert.rejects(verifyAndUnpack(h.deps, p3, { write: true }), /вне manifest\.json: x\/evil\.sh/);
  const k = await makeFake();
  const p4 = await writePackage(k.dirs.lib, '1.0.0', {}, { sig: false });
  await assert.rejects(verifyAndUnpack(k.deps, p4, { write: true }), /Нет файла подписи/);
});

test('уже распакованный каталог той же версии: тот же манифест заменяется, другой — отказ', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0');
  await verifyAndUnpack(f.deps, archive, { write: true });
  await writeFile(path.join(packagesDir(f), 'crp-1.0.0', 'stale.txt'), 'x');
  await verifyAndUnpack(f.deps, archive, { write: true });
  assert.deepEqual((await readdir(path.join(packagesDir(f), 'crp-1.0.0'))).includes('stale.txt'), false);
  // тот же номер версии, другая сборка
  await mkdir(path.join(f.dirs.lib, 'other'));
  const other = await writePackageArchive(path.join(f.dirs.lib, 'other'), '1.0.0', { buildId: 'other-build' });
  await assert.rejects(verifyAndUnpack(f.deps, other, { write: true }), /уже лежит другой пакет/);
  assert.deepEqual(await leftovers(f), []);
});

test('заглушка CRM_VERIFY_STUB=allow: только на стенде; без стенда подпись обязательна', async () => {
  const f = await makeFake();
  f.deps.env.CRM_VERIFY_STUB = 'allow';
  await rejected(f, await writePackageArchive(f.dirs.lib, '1.0.0', {}, { sig: false }), /Нет файла подписи/);

  const g = await makeFake();
  g.deps.env.CRM_VERIFY_STUB = 'allow';
  await writeFile(path.join(g.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  const archive = await writePackageArchive(g.dirs.lib, '1.0.0', {}, { sig: false });
  const v = await verifyAndUnpack(g.deps, archive, { write: false });
  assert.equal(v.verified, 'stub');
  assert.match(g.err.join('\n'), /подпись пакета НЕ проверена/);
  // без явного allow стенд тоже требует подпись
  const h = await makeFake();
  await writeFile(path.join(h.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  await assert.rejects(verifyAndUnpack(h.deps, await writePackageArchive(h.dirs.lib, '1.0.0', {}, { sig: false }), { write: false }), /Нет файла подписи/);
  // заглушка не прячет повреждённый состав: файлы всё равно сверяются
  const k = await makeFake();
  k.deps.env.CRM_VERIFY_STUB = 'allow';
  await writeFile(path.join(k.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  await assert.rejects(verifyAndUnpack(k.deps, await custom(k, (files) => files.set('images.tar', Buffer.from('images:9.9.9'))), { write: false }), /sha256 файла/);
});

test('crmctl keys: ключи релизов и отпечатки; ключи стенда только на стенде', async () => {
  const f = await makeFake();
  assert.equal(await run(['keys', '--json'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.out[0] as string), { release: FAKE_RELEASE_KEYS, stage: [] });
  const stage = makeKeyPair();
  await writeFile(path.join(f.dirs.etc, 'stage-keys.json'), JSON.stringify({ 'stage-a': stage.pub }));
  f.out.length = 0;
  assert.equal(await run(['keys', '--json'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.out[0] as string).stage, [], 'без CRM_STAND ключи стенда не показываются');
  await writeFile(path.join(f.dirs.etc, 'app.env'), 'CRM_STAND=1\n');
  f.out.length = 0;
  assert.equal(await run(['keys'], f.deps), 0);
  assert.match(f.out.join('\n'), new RegExp(`stage-a  ${keyFingerprint(stage.pub)}`));
  assert.match(f.out.join('\n'), /rel-test-a/);
});

test('crmctl package verify: код выхода 0 для верного пакета, 1 для испорченного; только чтение', async () => {
  const f = await makeFake();
  const archive = await writePackageArchive(f.dirs.lib, '1.0.0');
  assert.equal(await run(['package', 'verify', archive], f.deps), 0, f.err.join('\n'));
  assert.match(f.out.join('\n'), /клиент:\s+crp[\s\S]*версия:\s+1\.0\.0[\s\S]*ключ:\s+test-fake[\s\S]*файлов:\s+2[\s\S]*подпись принята/);
  assert.equal(f.calls.length, 0);
  assert.equal(await run(['package', 'verify'], f.deps), 2);
  const bad = await makeFake();
  assert.equal(await run(['package', 'verify', await writePackageArchive(bad.dirs.lib, '1.0.0', {}, { key: FOREIGN_KEYS.priv })], bad.deps), 1);
});
