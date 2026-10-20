// Пакет релиза (ARCHITECTURE §8.2 п. 6): каталог после распаковки crm-<клиент>-<версия>.tar.zst.
//   manifest.json  manifest.sig  images.tar (docker save)  compose/ (compose.yaml, postgres-init/)
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CrmctlError, type Deps, type PackageManifest } from './types';

export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const manifestSchema = z.object({
  customer: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(VERSION_RE),
  buildId: z.string().min(1).max(64),
  schemaVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.sql$/),
  configSchemaVersion: z.number().int().nonnegative(),
  minFromVersion: z.union([z.literal(''), z.string().regex(VERSION_RE)]),
  images: z
    .array(
      z.object({
        ref: z.string().regex(/^crm-app:[0-9A-Za-z][0-9A-Za-z._-]*$/),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});

/** Сравнение x.y.z[-pre]: отрицательное, если a < b. Пререлиз младше релиза с тем же x.y.z. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.split(/[-+]/, 2);
    return { n: core.split('.').map(Number), pre: v.includes('-') ? pre : '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.n[i] ?? 0) - (pb.n[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export async function readManifest(dir: string): Promise<PackageManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new CrmctlError(`В пакете нет manifest.json: ${dir}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CrmctlError('manifest.json не разбирается как JSON');
  }
  const res = manifestSchema.safeParse(json);
  if (!res.success) {
    const where = res.error.issues.map((i) => i.path.join('.') || '(корень)').join(', ');
    throw new CrmctlError(`manifest.json не прошёл проверку, поля: ${where}`);
  }
  const m = res.data;
  if (!m.images.some((i) => i.ref === `crm-app:${m.version}`)) {
    throw new CrmctlError(`В manifest.json нет образа crm-app:${m.version}`);
  }
  return m;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Пакет: каталог или .tar.zst (распаковывается в libDir/packages/<имя>). */
export async function openPackage(deps: Deps, pkg: string): Promise<{ dir: string; manifest: PackageManifest }> {
  let dir = pkg;
  if (!(await isDirectory(pkg))) {
    if (!/\.tar\.zst$/.test(pkg)) throw new CrmctlError(`Пакет должен быть каталогом или .tar.zst: ${pkg}`);
    const name = path.basename(pkg).replace(/\.tar\.zst$/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new CrmctlError('Недопустимое имя файла пакета');
    dir = path.join(deps.paths.libDir, 'packages', name);
    const r = await deps.exec.run('mkdir', ['-p', dir]);
    if (r.code !== 0) throw new CrmctlError(`Не создать каталог пакета: ${r.stderr.trim()}`);
    const t = await deps.exec.run('tar', ['--zstd', '-xf', pkg, '-C', dir, '--no-same-owner']);
    if (t.code !== 0) throw new CrmctlError(`Не распаковать пакет: ${t.stderr.trim()}`);
  }
  return { dir, manifest: await readManifest(dir) };
}
