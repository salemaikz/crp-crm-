// release-pack.ts (сборка без ключей) и release-sign.ts (подпись владельца) на ключах, созданных на лету, и полный
// прогон «собрать пакет -> подписать -> install -> update -> rollback» на фейке docker (docs/ops/release-design.md §5, §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../../../scripts/crmctl';
import { readState } from '../../../scripts/crmctl/state';
import { hashFile, keyFingerprint, scanArchive } from '../../../scripts/crmctl/package-format';
import { assertAllowedPath, assertNodeZstd, packRelease, type PackInput } from '../../../scripts/release-pack';
import { main as signMain, type SignIo } from '../../../scripts/release-sign';
import { imageId, makeFake } from './crmctl-fakes';

const REPO = process.cwd();

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'rel-'));
}

function cli(answers: string[] = []): { io: SignIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => answers.shift() ?? '' } };
}

async function keygen(dir: string, kid = 'rel-test'): Promise<{ key: string; pub: string }> {
  const key = path.join(dir, `release-private-${kid}.pem`);
  const c = cli();
  assert.equal(await signMain(['keygen', '--kid', kid, '--out', key], c.io), 0, c.err.join('\n'));
  const p = cli();
  assert.equal(await signMain(['pubkey', '--key', key], p.io), 0);
  return { key, pub: p.out[0] as string };
}

async function pack(dir: string, version: string, keys: { kid: string; pub: string }[], over: Partial<PackInput> = {}) {
  const tar = path.join(dir, `images-${version}.tar`);
  await writeFile(tar, `синтетический docker save ${version}`);
  return packRelease({
    customer: 'crp',
    version,
    buildId: `build-${version}`,
    builtAt: 1_790_000_000_000,
    commit: createHash('sha1').update(version).digest('hex'),
    minFromVersion: '',
    configSchemaVersion: 1,
    imagesTar: tar,
    imageDigest: imageId(`crm-app:${version}`),
    releaseKeys: keys.map((k) => ({ kid: k.kid, sha256: keyFingerprint(k.pub) })),
    repoRoot: REPO,
    outDir: path.join(dir, `out-${version}`),
    ...over,
  });
}

test('пакет: состав по §2.1, воспроизводимая сборка, install.sh исполняемый', async () => {
  const dir = await tmp();
  const k = await keygen(dir);
  const a = await pack(dir, '0.9.0-rc', [{ kid: 'rel-test', pub: k.pub }]);
  const names = a.manifest.files.map((f) => f.path);
  for (const must of ['images.tar', 'install.sh', 'compose/compose.yaml', 'compose/postgres-init/10-roles.sh', 'nginx/crm.conf.template', 'nginx/maintenance.html']) {
    assert.ok(names.includes(must), must);
  }
  assert.ok(names.some((n) => n.startsWith('migrations/') && n.endsWith('.sql')));
  assert.equal(a.manifest.schemaVersion, (await readdir(path.join(REPO, 'migrations'))).filter((n) => n.endsWith('.sql')).sort().at(-1));
  assert.equal(a.manifest.files.some((f) => /\.ts$|\.map$|\.env|\.pem|private/.test(f.path)), false);
  const seen = await scanArchive(a.archive, { verifyManifest: () => {} });
  assert.equal(seen.manifest.version, '0.9.0-rc');
  // та же сборка из другого каталога даёт тот же архив побайтно
  const b = await pack(dir, '0.9.0-rc', [{ kid: 'rel-test', pub: k.pub }], { outDir: path.join(dir, 'out-again') });
  assert.equal(b.archiveSha256, a.archiveSha256);
  assert.equal((await hashFile(a.archive)).sha256, a.archiveSha256);
});

test('пакет: запрещённые пути, расхождение миграций с образом и старый Node отвергаются', async () => {
  for (const bad of ['src/x', 'a.ts', 'a/b.tsx', 'x.js.map', '.env', 'conf/.env.local', 'k.pem', 'release-private-a', 'a.key', 'a.age', '../x']) {
    assert.throws(() => assertAllowedPath(bad), /путь/, bad);
  }
  assertAllowedPath('compose/compose.yaml');
  assert.throws(() => assertNodeZstd('22.14.0'), /22\.15/);
  assert.throws(() => assertNodeZstd('20.0.0'), /22\.15/);
  assertNodeZstd('22.15.0');

  const dir = await tmp();
  const imgMig = path.join(dir, 'img-mig');
  await mkdir(imgMig);
  await writeFile(path.join(imgMig, 'x.sql'), 'SELECT 1;');
  await assert.rejects(pack(dir, '0.9.0', [], { imageMigrationsDir: imgMig }), /расходится с миграциями образа/);
});

test('release-sign keygen: файл 0600, не перезаписывается, внутрь рабочего дерева git нельзя', async () => {
  const dir = await tmp();
  const key = path.join(dir, 'release-private-rel-a.pem');
  const c = cli();
  assert.equal(await signMain(['keygen', '--kid', 'rel-a', '--out', key], c.io), 0);
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  assert.match(c.out.join('\n'), /открытый ключ: .{44}/);
  assert.match(c.out.join('\n'), /release_keys/);
  const again = cli();
  assert.equal(await signMain(['keygen', '--kid', 'rel-a', '--out', key], again.io), 1);
  assert.match(again.err.join('\n'), /не перезаписываю/);
  const inRepo = cli();
  assert.equal(await signMain(['keygen', '--kid', 'rel-a', '--out', path.join(REPO, 'release-private-x.pem')], inRepo.io), 2);
  assert.match(inRepo.err.join('\n'), /внутрь рабочего дерева git/);
  assert.equal(await stat(path.join(REPO, 'release-private-x.pem')).then(() => true, () => false), false);
  const bad = cli();
  assert.equal(await signMain(['keygen', '--kid', 'test-a', '--out', path.join(dir, 'x.pem')], bad.io), 2);
});

test('release-sign sign: проверки до подписи и подпись, которую принимает crmctl', async () => {
  const dir = await tmp();
  const owner = await keygen(dir, 'rel-test');
  const reserve = await keygen(dir, 'rel-reserve');
  const built = await pack(dir, '0.9.0', [{ kid: 'rel-test', pub: owner.pub }, { kid: 'rel-reserve', pub: reserve.pub }]);
  const sigFile = built.archive.replace(/\.tar\.zst$/, '.manifest.sig');
  const args = ['sign', built.archive, '--key', owner.key, '--kid', 'rel-test', '--expect-sha256', built.archiveSha256];

  // sha256 не совпал: архив подменён
  let c = cli(['0.9.0']);
  assert.equal(await signMain(['sign', built.archive, '--key', owner.key, '--kid', 'rel-test', '--expect-sha256', 'a'.repeat(64)], c.io), 1);
  assert.match(c.err.join('\n'), /sha256 архива/);
  // резервный ключ владельцу незнаком
  c = cli(['0.9.0']);
  assert.equal(await signMain(args, c.io), 1);
  assert.match(c.out.join('\n'), /rel-reserve .*НЕ ИЗВЕСТЕН/);
  assert.match(c.err.join('\n'), /неизвестные ключи \(rel-reserve\)/);
  // известный набор из файла владельца
  const known = path.join(dir, 'known.json');
  await writeFile(known, JSON.stringify({ 'rel-test': owner.pub, 'rel-reserve': reserve.pub }));
  // версия не подтверждена
  c = cli(['9.9.9']);
  assert.equal(await signMain([...args, '--known-keys', known], c.io), 1);
  assert.match(c.err.join('\n'), /версия не подтверждена/);
  assert.equal(await stat(sigFile).then(() => true, () => false), false, 'подпись не выдана');
  // подтверждено
  c = cli(['0.9.0']);
  assert.equal(await signMain([...args, '--known-keys', known], c.io), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /клиент:\s+crp[\s\S]*версия:\s+0\.9\.0[\s\S]*commit:[\s\S]*releaseKeys[\s\S]*Подпись записана/);
  assert.match(c.out.join('\n'), new RegExp(`sha256 архива для первой установки .*: ${built.archiveSha256}`));
  // повторно не перезаписывает
  c = cli(['0.9.0']);
  assert.equal(await signMain([...args, '--known-keys', known], c.io), 1);

  // verify
  const v = cli();
  assert.equal(await signMain(['verify', built.archive, '--pubkey', owner.pub], v.io), 0, v.err.join('\n'));
  const vBad = cli();
  assert.equal(await signMain(['verify', built.archive, '--pubkey', reserve.pub], vBad.io), 1);

  // crmctl принимает: ключ вшит как rel-test
  const f = await makeFake();
  f.deps.trust.release = { 'rel-test': owner.pub, 'rel-reserve': reserve.pub };
  const { verifyAndUnpack } = await import('../../../scripts/crmctl/verify');
  const ok = await verifyAndUnpack(f.deps, built.archive, { write: false });
  assert.equal(ok.kid, 'rel-test');
  assert.equal(ok.verified, 'signature');
});

test('release-sign sign: общая сборка без ключей и ключ, которого нет в манифесте, не подписываются', async () => {
  const dir = await tmp();
  const owner = await keygen(dir, 'rel-test');
  const other = await keygen(dir, 'rel-other');
  const general = await pack(dir, '0.9.0', []);
  let c = cli(['0.9.0']);
  assert.equal(await signMain(['sign', general.archive, '--key', owner.key, '--kid', 'rel-test', '--expect-sha256', general.archiveSha256], c.io), 1);
  assert.match(c.err.join('\n'), /общей сборки/);
  const client = await pack(dir, '0.9.1', [{ kid: 'rel-test', pub: owner.pub }]);
  c = cli(['0.9.1']);
  assert.equal(await signMain(['sign', client.archive, '--key', other.key, '--kid', 'rel-other', '--expect-sha256', client.archiveSha256], c.io), 1);
  assert.match(c.err.join('\n'), /не входит в manifest\.releaseKeys/);
  c = cli(['0.9.1']);
  assert.equal(await signMain(['sign', client.archive, '--key', owner.key, '--kid', 'test-x', '--expect-sha256', client.archiveSha256], c.io), 2);
});

test('прогон: собрать пакет на тестовом ключе -> подписать -> install -> update -> rollback (фейк docker)', async () => {
  const dir = await tmp();
  const owner = await keygen(dir, 'rel-test');
  const keys = [{ kid: 'rel-test', pub: owner.pub }];
  const f = await makeFake();
  f.deps.trust.release = { 'rel-test': owner.pub };
  f.server.imageKeys = keys.map((k) => ({ kid: k.kid, sha256: keyFingerprint(k.pub) }));

  const sign = async (version: string): Promise<string> => {
    const p = await pack(dir, version, keys);
    const c = cli([version]);
    assert.equal(await signMain(['sign', p.archive, '--key', owner.key, '--kid', 'rel-test', '--expect-sha256', p.archiveSha256], c.io), 0, c.err.join('\n'));
    return p.archive;
  };

  const a1 = await sign('0.9.0');
  assert.equal(await run(['install', a1, '--domain', 'crm.example.kz', '--admin-phone', '77090000001', '--admin-name', 'Синтетика', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal((await readState(f.deps.paths))?.current.version, '0.9.0');

  const a2 = await sign('0.9.1');
  assert.equal(await run(['update', a2, '--wait-seconds', '1', '--recheck-seconds', '120'], f.deps), 0, f.err.join('\n'));
  const st = await readState(f.deps.paths);
  assert.equal(st?.current.version, '0.9.1');
  assert.equal(st?.previous?.version, '0.9.0');
  assert.equal(st?.current.kid, 'rel-test');

  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal((await readState(f.deps.paths))?.current.version, '0.9.0');
  assert.equal(f.server.running, '0.9.0');

  // вернуться вперёд тем же rollback
  assert.equal(await run(['rollback', '--wait-seconds', '1'], f.deps), 0, f.err.join('\n'));
  assert.equal(f.server.running, '0.9.1');

  // пакет, подписанный не владельцем, не ставится
  const stranger = await keygen(dir, 'rel-stranger');
  const p3 = await pack(dir, '0.9.2', keys);
  const c = cli(['0.9.2']);
  assert.equal(await signMain(['sign', p3.archive, '--key', stranger.key, '--kid', 'rel-test', '--expect-sha256', p3.archiveSha256], c.io), 1, 'ключ другого владельца под kid rel-test: отпечаток не входит в манифест');
});
