// Сборка релизного пакета crm-<клиент>-<версия>.tar.zst (docs/ops/release-design.md §2, §5.2, D-315).
// Запускается в CI и локально БЕЗ ключей: ничего не подписывает. Подпись — отдельный файл рядом с архивом
// (владелец: scripts/release-sign.ts; стенд: ключ stage).
//
//   tsx scripts/release-pack.ts --customer <клиент> --version <версия> --build-id <id> --built-at <epoch-мс>
//       --image crm-app:<версия>                          образ берётся из docker (docker save)
//       | --images-tar <файл> --image-digest sha256:<64>  готовый docker save (без docker)
//       [--release-keys <файл.json>]   { "rel-…": ключ base64 }; по умолчанию спрашивается crmctl образа
//       [--commit <40 hex>] [--min-from <версия>] [--config-schema <n>] [--migrations-dir <каталог>]
//       [--repo <корень>] [--out-dir <каталог>]
//   Печатает sha256 архива и манифеста: их владелец сверяет при подписи и передаёт root клиента (§6).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { VERSION_RE } from './crmctl/manifest';
import {
  MANIFEST_NAME,
  hashFile,
  isSafePackagePath,
  keyFingerprint,
  manifestSchema,
  writeArchive,
  type ReleaseManifest,
  type WriteMember,
} from './crmctl/package-format';

export interface PackInput {
  customer: string;
  version: string;
  buildId: string;
  builtAt: number;
  commit: string;
  minFromVersion: string;
  configSchemaVersion: number;
  /** docker save образа. */
  imagesTar: string;
  imageDigest: string;
  releaseKeys: { kid: string; sha256: string }[];
  /** Корень репозитория: deploy/ и migrations/. */
  repoRoot: string;
  /** Миграции из образа (docker cp) для побайтной сверки; без неё сверка пропускается. */
  imageMigrationsDir?: string;
  outDir: string;
}

export interface PackResult {
  archive: string;
  archiveSha256: string;
  manifestSha256: string;
  manifest: ReleaseManifest;
}

/** Пути, которых не должно быть в пакете (как в scripts/check-image.sh). */
const FORBIDDEN: RegExp[] = [/(^|\/)src(\/|$)/, /\.tsx?$/, /\.map$/, /(^|\/)\.env/, /\.pem$/, /private/i, /\.key$/, /\.age$/];

export function assertAllowedPath(p: string): void {
  if (!isSafePackagePath(p)) throw new Error(`небезопасный путь в пакете: ${p}`);
  for (const re of FORBIDDEN) if (re.test(p)) throw new Error(`запрещённый путь в пакете: ${p}`);
}

/** zstd есть в node:zlib с 22.15 (§2.2). */
export function assertNodeZstd(version = process.versions.node): void {
  const [maj = 0, min = 0] = version.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 15)) throw new Error(`нужен Node >= 22.15 (zstd в node:zlib), здесь ${version}`);
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = await stat(path.join(root, r));
    if (st.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

async function sameDir(a: string, b: string): Promise<boolean> {
  const fa = await listFiles(a);
  const fb = await listFiles(b);
  if (fa.join('\n') !== fb.join('\n')) return false;
  for (const f of fa) if (!(await readFile(path.join(a, f))).equals(await readFile(path.join(b, f)))) return false;
  return true;
}

/** Последняя миграция по имени файла: версия схемы пакета. */
export async function latestMigration(dir: string): Promise<string> {
  const all = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  if (all.length === 0) throw new Error(`в ${dir} нет миграций`);
  return all[all.length - 1] as string;
}

export async function packRelease(inp: PackInput): Promise<PackResult> {
  assertNodeZstd();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(inp.customer)) throw new Error('--customer: строчные буквы, цифры и дефис');
  if (!VERSION_RE.test(inp.version)) throw new Error('--version: x.y.z[-пре]');
  const migDir = path.join(inp.repoRoot, 'migrations');
  if (inp.imageMigrationsDir && !(await sameDir(migDir, inp.imageMigrationsDir))) {
    throw new Error('migrations/ репозитория расходится с миграциями образа: пакет не собран');
  }

  const members: WriteMember[] = [];
  const files: ReleaseManifest['files'] = [];
  const add = async (rel: string, abs: string, exec = false): Promise<void> => {
    assertAllowedPath(rel);
    const h = await hashFile(abs);
    files.push({ path: rel, sha256: h.sha256, size: h.size });
    members.push({ path: rel, kind: 'file', file: abs, size: h.size, exec });
  };
  const addDir = (rel: string): void => void members.push({ path: rel, kind: 'dir' });

  await add('images.tar', inp.imagesTar);
  addDir('compose');
  addDir('compose/postgres-init');
  const dep = path.join(inp.repoRoot, 'deploy');
  await add('compose/compose.yaml', path.join(dep, 'compose', 'compose.yaml'));
  for (const f of await listFiles(path.join(dep, 'compose', 'postgres-init'))) {
    await add(`compose/postgres-init/${f}`, path.join(dep, 'compose', 'postgres-init', f));
  }
  addDir('nginx');
  await add('nginx/crm.conf.template', path.join(dep, 'nginx', 'crm.conf.template'));
  await add('nginx/maintenance.html', path.join(dep, 'nginx', 'maintenance.html'));
  addDir('migrations');
  for (const f of (await readdir(migDir)).filter((n) => n.endsWith('.sql')).sort()) await add(`migrations/${f}`, path.join(migDir, f));
  await add('install.sh', path.join(dep, 'install.sh'), true);

  const manifest = manifestSchema.parse({
    format: 2,
    customer: inp.customer,
    version: inp.version,
    buildId: inp.buildId,
    builtAt: inp.builtAt,
    commit: inp.commit,
    schemaVersion: await latestMigration(migDir),
    configSchemaVersion: inp.configSchemaVersion,
    minFromVersion: inp.minFromVersion,
    images: [{ ref: `crm-app:${inp.version}`, digest: inp.imageDigest }],
    releaseKeys: inp.releaseKeys,
    files,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  members.unshift({ path: MANIFEST_NAME, kind: 'file', data: manifestBytes });

  await mkdir(inp.outDir, { recursive: true });
  const archive = path.join(inp.outDir, `crm-${inp.customer}-${inp.version}.tar.zst`);
  await writeArchive(archive, members, inp.builtAt);
  return {
    archive,
    archiveSha256: (await hashFile(archive)).sha256,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifest,
  };
}

function docker(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args[0]}: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`);
  return r.stdout;
}

export function parseKeyList(text: string): { kid: string; sha256: string }[] {
  const obj = JSON.parse(text) as unknown;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('release keys: ожидается объект kid → ключ');
  return Object.entries(obj as Record<string, string>)
    .map(([kid, b64]) => ({ kid, sha256: keyFingerprint(b64) }))
    .sort((a, b) => (a.kid < b.kid ? -1 : 1));
}

async function main(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      customer: { type: 'string' },
      version: { type: 'string' },
      'build-id': { type: 'string' },
      'built-at': { type: 'string' },
      image: { type: 'string' },
      'images-tar': { type: 'string' },
      'image-digest': { type: 'string' },
      'release-keys': { type: 'string' },
      commit: { type: 'string' },
      'min-from': { type: 'string' },
      'config-schema': { type: 'string' },
      repo: { type: 'string' },
      'out-dir': { type: 'string' },
    },
  });
  const need = (x: string | undefined, n: string): string => {
    if (!x) throw new Error(`нужен --${n}`);
    return x;
  };
  const repoRoot = path.resolve(v.repo ?? process.cwd());
  const version = need(v.version, 'version');
  const tmp = await mkdtemp(path.join(tmpdir(), 'release-pack-'));
  try {
    let imagesTar = v['images-tar'];
    let digest = v['image-digest'];
    let imageMigrationsDir: string | undefined;
    let releaseKeys: { kid: string; sha256: string }[];
    if (v.image) {
      imagesTar = path.join(tmp, 'images.tar');
      digest = docker(['image', 'inspect', '--format', '{{.Id}}', v.image]).trim();
      docker(['save', '-o', imagesTar, v.image]);
      const cid = docker(['create', v.image]).trim();
      try {
        imageMigrationsDir = path.join(tmp, 'image-migrations');
        docker(['cp', `${cid}:/app/migrations`, imageMigrationsDir]);
      } finally {
        spawnSync('docker', ['rm', '-f', cid]);
      }
      releaseKeys = v['release-keys']
        ? parseKeyList(await readFile(v['release-keys'], 'utf8'))
        : (JSON.parse(
            docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', v.image, 'dist/crmctl.mjs', 'keys', '--json']).trim().split('\n').pop() ?? '',
          ) as { release: { kid: string; sha256: string }[] }).release;
    } else {
      if (!imagesTar || !digest) throw new Error('нужен --image или пара --images-tar и --image-digest');
      releaseKeys = v['release-keys'] ? parseKeyList(await readFile(v['release-keys'], 'utf8')) : [];
    }
    let configSchema = v['config-schema'] === undefined ? undefined : Number(v['config-schema']);
    if (configSchema === undefined) {
      const { config } = (await import('@crm/core')) as unknown as { config: { CONFIG_SCHEMA_VERSION: number } };
      configSchema = config.CONFIG_SCHEMA_VERSION;
    }
    const commit =
      v.commit ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    const r = await packRelease({
      customer: need(v.customer, 'customer'),
      version,
      buildId: need(v['build-id'], 'build-id'),
      builtAt: Number(need(v['built-at'], 'built-at')),
      commit,
      minFromVersion: v['min-from'] ?? '',
      configSchemaVersion: configSchema,
      imagesTar,
      imageDigest: digest,
      releaseKeys,
      repoRoot,
      imageMigrationsDir,
      outDir: path.resolve(v['out-dir'] ?? 'release'),
    });
    console.log(`архив:          ${r.archive}`);
    console.log(`sha256 архива:  ${r.archiveSha256}`);
    console.log(`sha256 манифеста: ${r.manifestSha256}`);
    console.log(`клиент ${r.manifest.customer}, версия ${r.manifest.version}, файлов ${r.manifest.files.length}`);
    console.log(`ключи релизов: ${r.manifest.releaseKeys.map((k) => `${k.kid}:${k.sha256.slice(0, 16)}`).join(', ') || '— (общая сборка)'}`);
    return 0;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function isEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isEntry()) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
