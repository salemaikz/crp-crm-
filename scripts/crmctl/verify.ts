// Проверка подписи и распаковка релизного пакета (docs/ops/release-design.md §3–4, D-315, O4c).
// Подпись Ed25519 над manifest.json проверяет хостовый crmctl вшитыми ключами `rel-*` ДО любого вызова
// docker и записи в /etc/crm, compose/ и state.json. Ключи `stage-*` признаются только на стенде
// (CRM_STAND=1 в app.env), `test-*` — только через Deps в тестах. Ядро и БД модулю не нужны.
import { createHash, randomUUID, type KeyObject } from 'node:crypto';
import { type FileHandle, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MANIFEST_NAME,
  hashFile,
  keyFingerprint,
  parseManifest,
  parseSigFile,
  publicKeyFromRaw,
  scanArchive,
  verifyManifestSignature,
  type ReleaseManifest,
  type Sink,
} from './package-format';
import { isDirectory } from './manifest';
import { CrmctlError, type Deps } from './types';

// Подставляются esbuild define при сборке crmctl (build-cli.mjs); в тестах под tsx не определены
declare const __CRM_RELEASE_KEYS__: string | undefined;
declare const __CRM_CLIENT_BUILD__: boolean | undefined;
declare const __CRM_CUSTOMER__: string | undefined;

/** Ключи релизов, вшитые в этот crmctl: kid → сырой ключ base64. */
export function embeddedReleaseKeys(): Record<string, string> {
  if (typeof __CRM_RELEASE_KEYS__ === 'undefined' || !__CRM_RELEASE_KEYS__) return {};
  return JSON.parse(__CRM_RELEASE_KEYS__) as Record<string, string>;
}

/** Клиент, для которого собран этот crmctl (CUSTOMER_ID сборки); '' — общая сборка. */
export function embeddedCustomer(): string {
  return typeof __CRM_CUSTOMER__ === 'undefined' ? '' : __CRM_CUSTOMER__;
}

/** Стенд: в app.env есть CRM_STAND=1. На боевом сервере файла с таким признаком нет. */
export async function isStand(deps: Deps): Promise<boolean> {
  try {
    return /^CRM_STAND=1[ \t]*$/m.test(await readFile(path.join(deps.paths.etcDir, 'app.env'), 'utf8'));
  } catch {
    return false;
  }
}

/** Ветка заглушки есть только в общей сборке: в клиентской её вырезает define (§4.5). */
function stubAllowed(deps: Deps, stand: boolean): boolean {
  if (typeof __CRM_CLIENT_BUILD__ !== 'undefined' && __CRM_CLIENT_BUILD__) return false;
  return stand && deps.env.CRM_VERIFY_STUB === 'allow';
}

export interface KeySet {
  stand: boolean;
  keys: Map<string, KeyObject>;
  /** Сырые ключи для вывода `crmctl keys`: kid → base64. */
  raw: { release: Record<string, string>; stage: Record<string, string> };
}

/** Доверенный набор ключей по классам kid (§3). */
export async function loadKeySet(deps: Deps): Promise<KeySet> {
  const stand = await isStand(deps);
  const keys = new Map<string, KeyObject>();
  const release: Record<string, string> = {};
  const stage: Record<string, string> = {};
  for (const [kid, b64] of Object.entries(deps.trust.release)) {
    if (!kid.startsWith('rel-')) continue;
    release[kid] = b64;
    keys.set(kid, publicKeyFromRaw(b64));
  }
  for (const [kid, b64] of Object.entries(deps.trust.test ?? {})) {
    if (kid.startsWith('test-')) keys.set(kid, publicKeyFromRaw(b64));
  }
  if (stand) {
    try {
      const file = JSON.parse(await readFile(path.join(deps.paths.etcDir, 'stage-keys.json'), 'utf8')) as Record<string, unknown>;
      for (const [kid, b64] of Object.entries(file)) {
        // из файла стенда берутся только stage-*: rel-* оттуда не признаётся
        if (!kid.startsWith('stage-') || typeof b64 !== 'string') continue;
        stage[kid] = b64;
        keys.set(kid, publicKeyFromRaw(b64));
      }
    } catch {
      // файла нет или он не разобран: ключей стенда нет
    }
  }
  return { stand, keys, raw: { release, stage } };
}

/** Проверка подписи над байтами манифеста. Возвращает kid принявшего ключа. */
export function checkSignature(set: KeySet, manifestBytes: Buffer, sigText: string): string {
  const { kid, sig } = parseSigFile(sigText);
  const key = set.keys.get(kid);
  if (!key) throw new CrmctlError(`Подпись пакета не принята: ключ ${kid} не входит в доверенные`);
  if (!verifyManifestSignature(key, manifestBytes, sig)) throw new CrmctlError('Подпись пакета не принята: подпись не сходится');
  return kid;
}

export interface VerifiedPackage {
  /** Каталог пакета на диске ('' при проверке без записи архива). */
  dir: string;
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  manifestSha256: string;
  sigText: string;
  kid: string;
  verified: 'signature' | 'stub';
}

export interface VerifyOptions {
  /** Файл подписи; по умолчанию рядом с архивом или manifest.sig в каталоге. */
  sig?: string;
  /** Записывать ли распакованный архив в libDir/packages (false — только проверка). */
  write: boolean;
  /** Контекст установки (клиент, версия): исключение останавливает работу до записи. */
  check?: (m: ReleaseManifest) => void;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function findSigText(pkg: string, isDir: boolean, explicit: string | undefined, stand: boolean): Promise<string | null> {
  if (explicit) {
    const t = await readIfExists(explicit);
    if (t === null) throw new CrmctlError(`Файла подписи нет: ${explicit}`);
    return t;
  }
  if (isDir) return readIfExists(path.join(pkg, 'manifest.sig'));
  const base = pkg.replace(/\.tar\.zst$/, '');
  const names = [`${base}.manifest.sig`, ...(stand ? [`${base}.stage.sig`] : [])];
  for (const n of names) {
    const t = await readIfExists(n);
    if (t !== null) return t;
  }
  return null;
}

const NO_SIG = 'Нет файла подписи (<архив>.manifest.sig или --sig): пакет не принят';

/** Приёмник файла с ограничением на путь внутри каталога распаковки. */
function fileSink(root: string, rel: string, exec: boolean, handles: Set<FileHandle>): Promise<Sink> {
  const target = path.join(root, ...rel.split('/'));
  return (async () => {
    await mkdir(path.dirname(target), { recursive: true });
    const fh = await open(target, 'wx', exec ? 0o755 : 0o644);
    handles.add(fh);
    return {
      write: async (chunk: Buffer) => {
        let off = 0;
        while (off < chunk.length) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
      },
      end: async () => {
        handles.delete(fh);
        await fh.close();
      },
    };
  })();
}

/** Обход каталога пакета через lstat: ссылки и особые файлы — отказ. Возвращает относительные пути файлов. */
async function walkFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(path.join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = await lstat(path.join(root, r));
    if (st.isSymbolicLink()) throw new CrmctlError(`В каталоге пакета ссылка: ${r}`);
    if (st.isDirectory()) out.push(...(await walkFiles(root, r)));
    else if (st.isFile()) out.push(r);
    else throw new CrmctlError(`В каталоге пакета особый файл: ${r}`);
  }
  return out;
}

async function verifyDirectory(
  dir: string,
  verifyManifest: (bytes: Buffer) => void,
  check: ((m: ReleaseManifest) => void) | undefined,
): Promise<{ manifest: ReleaseManifest; manifestBytes: Buffer }> {
  const mp = path.join(dir, MANIFEST_NAME);
  const st = await lstat(mp).catch(() => null);
  if (!st?.isFile()) throw new CrmctlError(`В пакете нет manifest.json: ${dir}`);
  const manifestBytes = await readFile(mp);
  verifyManifest(manifestBytes);
  const manifest = parseManifest(manifestBytes);
  check?.(manifest);
  const files = await walkFiles(dir);
  const want = new Map(manifest.files.map((f) => [f.path, f]));
  for (const f of files) {
    if (f === MANIFEST_NAME || f === 'manifest.sig') continue;
    if (!want.has(f)) throw new CrmctlError(`В каталоге пакета файл вне manifest.json: ${f}`);
  }
  const have = new Set(files);
  for (const f of manifest.files) {
    if (!have.has(f.path)) throw new CrmctlError(`В каталоге пакета нет файла из manifest.json: ${f.path}`);
    const h = await hashFile(path.join(dir, f.path));
    if (h.size !== f.size || h.sha256 !== f.sha256) throw new CrmctlError(`Файл ${f.path} не совпадает с manifest.json (размер или sha256)`);
  }
  return { manifest, manifestBytes };
}

/**
 * Проверить пакет (архив .tar.zst или каталог) и, для архива при opts.write, распаковать его в
 * libDir/packages/<клиент>-<версия>/. До возврата ни docker, ни /etc/crm, ни compose/, ни state.json не трогаются.
 */
export async function verifyAndUnpack(deps: Deps, pkg: string, opts: VerifyOptions): Promise<VerifiedPackage> {
  const set = await loadKeySet(deps);
  const stub = stubAllowed(deps, set.stand);
  const isDir = await isDirectory(pkg);
  if (!isDir && !/\.tar\.zst$/.test(pkg)) throw new CrmctlError(`Пакет должен быть каталогом или .tar.zst: ${pkg}`);
  const sigFound = await findSigText(pkg, isDir, opts.sig, set.stand);
  if (sigFound === null && !stub) throw new CrmctlError(NO_SIG);

  let kid = '';
  let verified: 'signature' | 'stub' = 'signature';
  const sigText = sigFound ?? '';
  const verifyManifest = (bytes: Buffer): void => {
    try {
      if (sigFound === null) throw new CrmctlError(NO_SIG);
      kid = checkSignature(set, bytes, sigFound);
    } catch (e) {
      // В клиентской сборке define превращает условие в константу, и всё ниже вырезается из файла (§4.5)
      if (typeof __CRM_CLIENT_BUILD__ !== 'undefined' && __CRM_CLIENT_BUILD__) throw e;
      if (!stub) throw e;
      verified = 'stub';
      kid = '';
      deps.io.err(`ВНИМАНИЕ: подпись пакета НЕ проверена (CRM_VERIFY_STUB=allow, стенд): ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (isDir) {
    const r = await verifyDirectory(pkg, verifyManifest, opts.check);
    return done(r.manifest, r.manifestBytes, pkg);
  }

  const packagesDir = path.join(deps.paths.libDir, 'packages');
  const incoming = path.join(packagesDir, `.incoming-${randomUUID()}`);
  const handles = new Set<FileHandle>();
  try {
    const r = await scanArchive(pkg, {
      verifyManifest,
      onAccepted: async (m) => {
        opts.check?.(m);
        if (opts.write) await mkdir(incoming, { recursive: true });
      },
      sinkFor: opts.write ? (rel, m) => fileSink(incoming, rel, m.exec, handles) : undefined,
      onDir: opts.write ? async (rel) => void (await mkdir(path.join(incoming, ...rel.split('/')), { recursive: true })) : undefined,
    });
    if (!opts.write) return done(r.manifest, r.manifestBytes, '');
    await writeFile(path.join(incoming, MANIFEST_NAME), r.manifestBytes, { mode: 0o644 });
    if (sigText) await writeFile(path.join(incoming, 'manifest.sig'), sigText, { mode: 0o644 });
    const final = path.join(packagesDir, `${r.manifest.customer}-${r.manifest.version}`);
    const old = await readFile(path.join(final, MANIFEST_NAME)).catch(() => null);
    if (old !== null) {
      if (!old.equals(r.manifestBytes)) {
        throw new CrmctlError(`В ${final} уже лежит другой пакет этой версии; удалите каталог вручную, если он не нужен`);
      }
      await rm(final, { recursive: true, force: true });
    }
    await rename(incoming, final);
    return done(r.manifest, r.manifestBytes, final);
  } catch (e) {
    for (const h of handles) await h.close().catch(() => {});
    await rm(incoming, { recursive: true, force: true });
    throw e;
  }

  function done(manifest: ReleaseManifest, manifestBytes: Buffer, dir: string): VerifiedPackage {
    return {
      dir,
      manifest,
      manifestBytes,
      manifestSha256: sha256(manifestBytes),
      sigText,
      kid,
      verified,
    };
  }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Отпечатки ключей релизов этого crmctl (`crmctl keys`). */
export function releaseKeyList(set: KeySet): { kid: string; sha256: string }[] {
  return Object.entries(set.raw.release)
    .map(([kid, b64]) => ({ kid, sha256: keyFingerprint(b64) }))
    .sort((a, b) => (a.kid < b.kid ? -1 : 1));
}

/** Наборы ключей одинаковы (порядок не важен). */
export function sameKeys(a: { kid: string; sha256: string }[], b: { kid: string; sha256: string }[]): boolean {
  const norm = (x: { kid: string; sha256: string }[]) => x.map((k) => `${k.kid}:${k.sha256}`).sort().join('\n');
  return norm(a) === norm(b);
}

/** Каждый ключ из `sub` есть в `sup`. */
export function keysSubset(sub: { kid: string; sha256: string }[], sup: { kid: string; sha256: string }[]): boolean {
  const have = new Set(sup.map((k) => `${k.kid}:${k.sha256}`));
  return sub.every((k) => have.has(`${k.kid}:${k.sha256}`));
}

/**
 * Для dir-формы: рядом с state нужна копия манифеста и подписи, чтобы rollback мог их перепроверить (§4.4).
 * Каталог, распакованный из архива, уже лежит в packages/<клиент>-<версия>/.
 */
export async function keepManifest(deps: Deps, v: VerifiedPackage): Promise<void> {
  const target = path.join(deps.paths.libDir, 'packages', `${v.manifest.customer}-${v.manifest.version}`);
  if (path.resolve(v.dir) === path.resolve(target)) return;
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, MANIFEST_NAME), v.manifestBytes, { mode: 0o644 });
  if (v.sigText) await writeFile(path.join(target, 'manifest.sig'), v.sigText, { mode: 0o644 });
}
