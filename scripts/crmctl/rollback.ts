// crmctl rollback: вернуть прежнюю версию образа (DEPLOY §5.2). БД не откатывается: миграции только
// добавляющие, прежняя версия читает новую схему (D-060). До переключения ядро целевого образа спрашивается о
// водяном знаке: образ другого клиента, общий или без времени сборки (до D-290) не поднимается (D-307).
import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { intFlag, type ParsedArgs } from './args';
import { assertImageForCustomer } from './license';
import { isDirectory } from './manifest';
import { imageExists, syncCli } from './images';
import { parseManifest } from './package-format';
import { restoreVersion } from './update';
import { checkSignature, isStand, keysSubset, loadKeySet, releaseKeyList, sha256 } from './verify';
import { composeFile, requireState, type State } from './state';
import { CrmctlError, type Deps, type PackageManifest } from './types';

/**
 * §4.4: перед откатом перепроверяется то, что сохранил `update`: manifest.json в packages/ совпадает с записью
 * в state.json, подпись проходит текущим доверенным набором, Id образа равен digest. Нет записи или ключ
 * отозван — на бою откат запрещён (нужен пакет через update), на стенде идёт с предупреждением.
 */
async function verifyStored(deps: Deps, customer: string, target: NonNullable<Awaited<ReturnType<typeof requireState>>['previous']>): Promise<PackageManifest | null> {
  const stand = await isStand(deps);
  const dir = path.join(deps.paths.libDir, 'packages', `${customer}-${target.version}`);
  const mbytes = await readFile(path.join(dir, 'manifest.json')).catch(() => null);
  const sigText = await readFile(path.join(dir, 'manifest.sig'), 'utf8').catch(() => null);
  let problem: string | null = null;
  let manifest: PackageManifest | null = null;
  if (!target.manifestSha256 || !target.verified) problem = 'о версии нет записи о проверке подписи';
  else if (mbytes === null) problem = 'сохранённого manifest.json нет';
  else if (sha256(mbytes) !== target.manifestSha256) problem = 'сохранённый manifest.json изменён';
  else if (target.verified === 'stub') problem = 'версия была поставлена без проверки подписи (заглушка стенда)';
  else if (sigText === null) problem = 'сохранённой подписи нет';
  else {
    try {
      checkSignature(await loadKeySet(deps), mbytes, sigText);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  }
  if (mbytes !== null && sha256(mbytes) === target.manifestSha256) {
    try {
      manifest = parseManifest(mbytes);
    } catch (e) {
      problem ??= e instanceof Error ? e.message : String(e);
    }
  }
  if (problem) {
    if (!stand) throw new CrmctlError(`Откат на ${target.version} запрещён: ${problem}. Нужен пакет через crmctl update`);
    deps.io.err(`Предупреждение (стенд): ${problem}`);
  }
  if (manifest) {
    const ref = `crm-app:${target.version}`;
    const want = manifest.images.find((i) => i.ref === ref)?.digest;
    const r = await deps.exec.run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref]);
    if (r.code !== 0 || r.stdout.trim() !== want) {
      throw new CrmctlError(`Откат на ${target.version} невозможен: Id образа ${ref} не совпадает с подписанным manifest.json`);
    }
  }
  return manifest;
}

export async function rollback(deps: Deps, args: ParsedArgs): Promise<number> {
  const waitMs = intFlag(args.flags, 'wait-seconds', 90) * 1000;
  const state = await requireState(deps.paths);
  if (!state.previous) throw new CrmctlError('Откатываться некуда: прежняя версия не записана');
  const target = state.previous;
  if (!(await imageExists(deps, `crm-app:${target.version}`))) {
    throw new CrmctlError(`Образа crm-app:${target.version} нет на сервере (почищен?). Загрузите пакет через crmctl update`);
  }
  const stored = await verifyStored(deps, state.customer, target);
  await assertImageForCustomer(deps, `crm-app:${target.version}`, state.customer, `Откат на ${target.version} невозможен`, stored?.builtAt);
  deps.io.out(`Откат ${state.current.version} -> ${target.version}`);
  deps.io.out('Внимание: правки настроек, сделанные версией ' + state.current.version + ', после отката не видны (D-060).');
  const next: State = {
    ...state,
    current: { ...target, switchedAt: deps.now() },
    previous: {
      version: state.current.version,
      buildId: state.current.buildId,
      ...(state.current.manifestSha256 ? { manifestSha256: state.current.manifestSha256 } : {}),
      ...(state.current.kid !== undefined ? { kid: state.current.kid } : {}),
      ...(state.current.verified ? { verified: state.current.verified } : {}),
    },
  };
  // Меняем местами compose и compose.prev: повторный rollback вернёт файлы обратно
  const cur = path.dirname(composeFile(deps.paths));
  const prev = path.join(deps.paths.libDir, 'compose.prev');
  const tmp = path.join(deps.paths.libDir, 'compose.swap');
  if (await isDirectory(prev)) {
    await rm(tmp, { recursive: true, force: true });
    await rename(cur, tmp);
    await rename(prev, cur);
    await rename(tmp, prev);
  }
  const ok = await restoreVersion(deps, next, waitMs, false);
  if (!ok) {
    deps.io.err(`Версия ${target.version} не отвечает на /api/health. Нужно вмешательство: docker compose -p crm logs app`);
    return 2;
  }
  // crmctl прежнего образа ставится на хост, только если его ключи релизов не шире текущих: откат не возвращает
  // доверие к отозванному ключу (§4.4)
  if (stored && !keysSubset(stored.releaseKeys, releaseKeyList(await loadKeySet(deps)))) {
    deps.io.err('Предупреждение: crmctl прежней версии доверяет ключам, которых нет у текущего; остаётся текущий crmctl');
  } else {
    await syncCli(deps, target.version);
  }
  deps.io.out(`Работает ${target.version}.`);
  return 0;
}
