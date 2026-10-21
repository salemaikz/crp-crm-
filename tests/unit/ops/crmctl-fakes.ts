// Подмена docker/compose и ФС хоста для тестов crmctl. Фейк ведёт модель сервера: какая версия
// «запущена», какие образы загружены, какая схема накатана, и записывает все вызовы.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Deps, Executor, PackageManifest, RunOptions, RunResult, Verifier } from '../../../scripts/crmctl/types';
import { writeProjectEnv, writeState, type State } from '../../../scripts/crmctl/state';
import { encodeSigFile, keyFingerprint, rawPublicKeyBase64, signingBytes, writeArchive } from '../../../scripts/crmctl/package-format';

/** Ключи тестов создаются на лету (D-315 §7): закрытой половины нет ни в репозитории, ни на диске. */
export function makeKeyPair(): { priv: KeyObject; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { priv: privateKey, pub: rawPublicKeyBase64(publicKey) };
}
export const TEST_KID = 'test-fake';
export const TEST_KEYS = makeKeyPair();
/** Другая пара: подпись «чужим» ключом, которого crmctl не знает. */
export const FOREIGN_KEYS = makeKeyPair();
/** Ключи релизов, которые «несёт» crmctl (вшиты) и перечисляет манифест: пары созданы на лету. */
export const REL_A = makeKeyPair();
export const REL_B = makeKeyPair();
export const FAKE_RELEASE_KEYS = [
  { kid: 'rel-test-a', sha256: keyFingerprint(REL_A.pub) },
  { kid: 'rel-test-b', sha256: keyFingerprint(REL_B.pub) },
];
export const FAKE_RELEASE_PUB = { 'rel-test-a': REL_A.pub, 'rel-test-b': REL_B.pub };

export interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  input?: string;
}

export const imageId = (ref: string) => `sha256:${createHash('sha256').update(ref).digest('hex')}`;
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

export interface FakeServer {
  /** Версия, которую «крутит» app сейчас (по последнему compose up app). */
  running: string;
  images: Set<string>;
  schema: string;
  pending: boolean;
  /** Версии, которые не здоровы. */
  unhealthy: Set<string>;
  /** Версии, у которых не здоров кандидат (docker run + exec). */
  candidateUnhealthy: Set<string>;
  backupCode: number;
  migrateCode: number;
  composeUpFails: Set<string>;
  /** Вызывается при sleep (например, «через 2 минуты приложение упало»). */
  onSleep?: () => void;
  candidate?: string;
  /** Версии, у которых worker не становится healthy. */
  workerUnhealthy: Set<string>;
  /** Что сообщает `crmctl keys --json` образа. */
  imageKeys: { kid: string; sha256: string }[];
  /**
   * Водяной знак ядра образа для `docker run … license verify` (D-213); customer null — общий образ.
   * builtAt нет или null — образ собран до D-290 (install, update и rollback его не ставят, D-307).
   */
  imageWatermark: { customer: string | null; buildId: string | null; builtAt?: number | null };
}

export interface Fake {
  deps: Deps;
  server: FakeServer;
  calls: Call[];
  out: string[];
  err: string[];
  dirs: { etc: string; lib: string; cli: string; nginxConf: string };
  verdicts: { license: boolean };
  sleeps: number[];
  /** Номера вызовов compose-подкоманд, например ['up','run']. */
  compose(sub: string): Call[];
}

export type Override = (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult | undefined> | RunResult | undefined;

function composeSub(args: string[]): string[] {
  const i = args.indexOf('--env-file');
  return i === -1 ? [] : args.slice(i + 2);
}

export async function makeFake(override?: Override, now = 1_800_000_000_000): Promise<Fake> {
  const root = await mkdtemp(path.join(tmpdir(), 'crmctl-test-'));
  const dirs = {
    etc: path.join(root, 'etc'),
    lib: path.join(root, 'lib'),
    cli: path.join(root, 'cli'),
    /** Конфиг nginx «на хосте» (CRM_NGINX_CONF); по умолчанию файла нет. */
    nginxConf: path.join(root, 'nginx', 'crm.conf'),
  };
  await mkdir(dirs.etc, { recursive: true });
  await mkdir(dirs.lib, { recursive: true });
  await mkdir(dirs.cli, { recursive: true });
  const server: FakeServer = {
    running: '',
    images: new Set(),
    schema: '2026-10-21-platform-schema-v1.sql',
    pending: false,
    unhealthy: new Set(),
    candidateUnhealthy: new Set(),
    backupCode: 0,
    migrateCode: 0,
    composeUpFails: new Set(),
    workerUnhealthy: new Set(),
    imageKeys: FAKE_RELEASE_KEYS,
    imageWatermark: { customer: 'crp', buildId: null, builtAt: 1_790_000_000_000 },
  };
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const verdicts = { license: true };

  const exec: Executor = {
    async run(cmd, args, opts = {}) {
      calls.push({ cmd, args, env: opts.env, input: opts.input });
      const o = await override?.(cmd, args, opts);
      if (o) return o;
      if (cmd === '/fake/backup.sh') return server.backupCode === 0 ? ok() : fail('backup failed');
      if (cmd !== 'docker') return ok(); // mkdir, tar, mv
      const a = args;
      if (a[0] === 'compose' && a[1] === 'version') return ok('v2');
      if (a[0] === 'version' || a[0] === 'network') return ok('27.0');
      if (a[0] === 'load') {
        return ok();
      }
      if (a[0] === 'image' && a[1] === 'inspect') {
        const ref = a[a.length - 1] as string;
        if (a.includes('--format')) {
          server.images.add(ref);
          return ok(`${imageId(ref)}\n`);
        }
        return server.images.has(ref) ? ok() : fail('No such image');
      }
      // Проверка лицензии ядром образа без файла: «missing» и водяной знак (тесты с файлом подменяют override)
      if (a[0] === 'run' && a.includes('dist/crmctl.mjs') && a.includes('keys')) {
        return ok(`${JSON.stringify({ release: server.imageKeys, stage: [] })}\n`);
      }
      if (a[0] === 'run' && a.includes('dist/crmctl.mjs') && a.includes('license')) {
        return { code: 3, stdout: `${JSON.stringify({ ok: false, reason: 'missing', watermark: server.imageWatermark })}\n`, stderr: '' };
      }
      if (a[0] === 'run' && a.includes('--entrypoint')) return ok('-- grants\nSELECT 1;\n');
      if (a[0] === 'run' && a.includes('-d')) {
        server.candidate = (a[a.length - 1] as string).replace('crm-app:', '');
        return ok('cid');
      }
      if (a[0] === 'exec') {
        const v = server.candidate ?? '';
        if (server.candidateUnhealthy.has(v)) return ok(`${JSON.stringify({ status: 503, body: '' })}\n`);
        return ok(`${JSON.stringify({ status: 200, body: JSON.stringify({ version: v }) })}\n`);
      }
      if (a[0] === 'rm' || a[0] === 'create' || a[0] === 'cp') return ok();
      if (a[0] === 'compose') {
        const sub = composeSub(a);
        const version = opts.env?.CRM_VERSION ?? '';
        if (sub[0] === 'up') {
          if (sub.includes('app')) {
            if (server.composeUpFails.has(version)) return fail('up failed');
            server.running = version;
          }
          return ok();
        }
        if (sub[0] === 'run') {
          if (sub.includes('--status')) return { code: server.pending ? 3 : 0, stdout: '', stderr: '' };
          if (server.migrateCode !== 0) return fail('migrate failed', server.migrateCode);
          server.pending = false;
          return ok('Применены миграции: x');
        }
        if (sub[0] === 'exec') {
          const input = opts.input ?? '';
          if (input.includes('max(name)')) return ok(`${server.schema}\n`);
          if (input.includes('pg_roles WHERE rolname = \'crm_owner\'')) return ok('1\n');
          if (input.includes('FROM license_state WHERE id = 1')) return ok('11111111-2222-3333-4444-555555555555\n');
          return ok();
        }
        if (sub[0] === 'ps') {
          if (sub.includes('worker')) return ok(server.workerUnhealthy.has(server.running) ? 'starting\n' : 'healthy\n');
          return ok('app\trunning\thealthy');
        }
      }
      return ok();
    },
  };

  const verifier: Verifier = {
    verifyLicense: async () => (verdicts.license ? { ok: true } : { ok: false, reason: 'invalid: чужой водяной знак' }),
  };

  const deps: Deps = {
    exec,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { CRM_NGINX_CONF: dirs.nginxConf },
    paths: { etcDir: dirs.etc, libDir: dirs.lib, backupCmd: '/fake/backup.sh', cliDir: dirs.cli },
    verifier,
    trust: { release: { ...FAKE_RELEASE_PUB }, test: { [TEST_KID]: TEST_KEYS.pub } },
    http: async (url) => {
      if (!url.endsWith('/api/health')) return { status: 404, body: '' };
      const bad = server.unhealthy.has(server.running);
      return { status: bad ? 503 : 200, body: JSON.stringify({ version: server.running }) };
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      server.onSleep?.();
    },
    randomBytes: (() => {
      let i = 0;
      return (n: number) => Buffer.alloc(n, 1 + (i++ % 250));
    })(),
    randomUuid: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8000-${String(++i).padStart(12, '0')}`;
    })(),
  };

  return {
    deps,
    server,
    calls,
    out,
    err,
    dirs,
    verdicts,
    sleeps,
    compose: (sub) => calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'compose' && composeSub(c.args)[0] === sub),
  };
}

export function manifestFor(version: string, over: Partial<PackageManifest> = {}): PackageManifest {
  const files = fileBodies(version);
  return {
    format: 2,
    customer: 'crp',
    version,
    buildId: `build-${version}`,
    builtAt: 1_790_000_000_000,
    commit: createHash('sha1').update(`commit-${version}`).digest('hex'),
    schemaVersion: '2026-10-21-platform-schema-v1.sql',
    configSchemaVersion: 1,
    minFromVersion: '',
    images: [{ ref: `crm-app:${version}`, digest: imageId(`crm-app:${version}`) }],
    releaseKeys: FAKE_RELEASE_KEYS,
    files: [...files].map(([p, b]) => ({ path: p, sha256: createHash('sha256').update(b).digest('hex'), size: b.length })),
    ...over,
  };
}

/** Содержимое файлов пакета: образ-заглушка и compose версии. */
export function fileBodies(version: string): Map<string, Buffer> {
  return new Map([
    ['compose/compose.yaml', Buffer.from(`# compose для ${version}\n`)],
    ['images.tar', Buffer.from(`images:${version}`)],
  ]);
}

export function signManifest(bytes: Buffer, key: KeyObject = TEST_KEYS.priv, kid = TEST_KID): string {
  return encodeSigFile(kid, sign(null, signingBytes(bytes), key));
}

/** Каталог пакета: manifest.json, manifest.sig (подпись test-fake), images.tar, compose/compose.yaml. */
export async function writePackage(
  dir: string,
  version: string,
  over: Partial<PackageManifest> = {},
  opts: { key?: KeyObject; kid?: string; sig?: boolean; manifestBytes?: Buffer } = {},
): Promise<string> {
  const pkg = path.join(dir, `pkg-${version}`);
  for (const [p, body] of fileBodies(version)) {
    await mkdir(path.dirname(path.join(pkg, p)), { recursive: true });
    await writeFile(path.join(pkg, p), body);
  }
  const bytes = opts.manifestBytes ?? Buffer.from(JSON.stringify(manifestFor(version, over)));
  await writeFile(path.join(pkg, 'manifest.json'), bytes);
  if (opts.sig !== false) await writeFile(path.join(pkg, 'manifest.sig'), signManifest(bytes, opts.key, opts.kid));
  return pkg;
}

/** Архив .tar.zst и подпись рядом (`<имя>.manifest.sig`). Возвращает путь архива. */
export async function writePackageArchive(
  dir: string,
  version: string,
  over: Partial<PackageManifest> = {},
  opts: { key?: KeyObject; kid?: string; sig?: boolean } = {},
): Promise<string> {
  const m = manifestFor(version, over);
  const bytes = Buffer.from(JSON.stringify(m));
  const out = path.join(dir, `crm-${m.customer}-${version}.tar.zst`);
  const members = [...fileBodies(version)].map(([p, data]) => ({ path: p, kind: 'file' as const, data }));
  await writeArchive(out, [{ path: 'manifest.json', kind: 'file', data: bytes }, { path: 'compose', kind: 'dir' }, ...members], m.builtAt);
  if (opts.sig !== false) await writeFile(out.replace(/\.tar\.zst$/, '.manifest.sig'), signManifest(bytes, opts.key, opts.kid));
  return out;
}

export { keyFingerprint };

/** app.env «старой» установки: синтетика, без CRM_PROXY_SECRET. */
export const SEED_APP_ENV = [
  '# Создан crmctl install.',
  'DATABASE_URL=postgres://crm_app:synthetic@db:5432/crm',
  'APP_ORIGIN=https://crm.example.kz',
  'TRUST_X_REAL_IP=1',
  'TELEMETRY=off',
  '',
].join('\n');

/** Установка уже сделана: state.json, project.env, compose/, образ версии загружен и «запущен». */
export async function seedInstalled(f: Fake, version: string, previous: string | null = null): Promise<State> {
  const state: State = {
    installId: '11111111-2222-3333-4444-555555555555',
    customer: 'crp',
    current: { version, buildId: `build-${version}`, switchedAt: 1 },
    previous: previous ? { version: previous, buildId: `build-${previous}` } : null,
    hostPort: 3100,
  };
  await mkdir(path.join(f.dirs.lib, 'compose'), { recursive: true });
  await writeFile(path.join(f.dirs.lib, 'compose', 'compose.yaml'), `# compose для ${version}\n`);
  await writeState(f.deps.paths, state);
  // app.env установки до D-155: без CRM_PROXY_SECRET (update его допишет)
  await writeFile(path.join(f.dirs.etc, 'app.env'), SEED_APP_ENV, { mode: 0o600 });
  await writeProjectEnv(f.deps.paths, version, state.current.buildId, 3100);
  // Сохранённые update/install манифест и подпись версий: по ним rollback перепроверяет прежнюю версию (§4.4)
  for (const v of previous ? [version, previous] : [version]) {
    const bytes = Buffer.from(JSON.stringify(manifestFor(v)));
    const pdir = path.join(f.dirs.lib, 'packages', `crp-${v}`);
    await mkdir(pdir, { recursive: true });
    await writeFile(path.join(pdir, 'manifest.json'), bytes);
    await writeFile(path.join(pdir, 'manifest.sig'), signManifest(bytes));
    const rec = { manifestSha256: createHash('sha256').update(bytes).digest('hex'), kid: TEST_KID, verified: 'signature' as const };
    if (v === version) Object.assign(state.current, rec);
    else if (state.previous) Object.assign(state.previous, rec);
  }
  await writeState(f.deps.paths, state);
  f.server.running = version;
  f.server.images.add(`crm-app:${version}`);
  if (previous) f.server.images.add(`crm-app:${previous}`);
  return state;
}
