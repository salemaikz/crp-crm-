// Образы пакета: docker load, сверка идентификатора с manifest.json, обновление самого crmctl из образа.
import path from 'node:path';
import { describe } from './compose';
import { CrmctlError, type Deps, type PackageManifest } from './types';

export async function loadImages(deps: Deps, dir: string, manifest: PackageManifest): Promise<void> {
  const load = await deps.exec.run('docker', ['load', '-i', path.join(dir, 'images.tar')]);
  if (load.code !== 0) throw new CrmctlError(`docker load: ${describe(load)}`);
  for (const img of manifest.images) {
    const r = await deps.exec.run('docker', ['image', 'inspect', '--format', '{{.Id}}', img.ref]);
    if (r.code !== 0) throw new CrmctlError(`После загрузки нет образа ${img.ref}`);
    if (r.stdout.trim() !== img.digest) {
      throw new CrmctlError(`Образ ${img.ref} не совпадает с manifest.json (ожидался ${img.digest})`);
    }
  }
}

export async function imageExists(deps: Deps, ref: string): Promise<boolean> {
  return (await deps.exec.run('docker', ['image', 'inspect', ref])).code === 0;
}

/**
 * crmctl.mjs той версии, что запущена, лежит в её образе (dist/crmctl.mjs). Копируем его рядом с
 * node, чтобы следующий вызов crmctl соответствовал текущей версии. Сбой не фатален: предупреждение.
 */
export async function syncCli(deps: Deps, version: string): Promise<void> {
  const name = `crm-cli-sync-${version}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  const target = path.join(deps.paths.cliDir, 'crmctl.mjs');
  try {
    const c = await deps.exec.run('docker', ['create', '--name', name, `crm-app:${version}`]);
    if (c.code !== 0) throw new Error(describe(c));
    const cp = await deps.exec.run('docker', ['cp', `${name}:/app/dist/crmctl.mjs`, `${target}.new`]);
    if (cp.code !== 0) throw new Error(describe(cp));
    const mv = await deps.exec.run('mv', ['-f', `${target}.new`, target]);
    if (mv.code !== 0) throw new Error(describe(mv));
  } catch (e) {
    deps.io.err(`Предупреждение: crmctl не обновлён из образа ${version}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await deps.exec.run('docker', ['rm', '-f', name]);
  }
}
