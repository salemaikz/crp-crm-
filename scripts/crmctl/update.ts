// crmctl update <пакет> (DEPLOY §5.2, ARCHITECTURE §8.3). До шага «переключение» старая версия работает
// без изменений: любой сбой раньше него просто останавливает обновление. После — автооткат.
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { intFlag, type ParsedArgs } from './args';
import { CANDIDATE_NAME, compose, describe } from './compose';
import { applyGrants, currentSchema, pendingMigrations, runMigrate } from './db';
import { probeCandidate, probeHost, probeWorker, waitHealthy } from './health';
import { loadImages, syncCli } from './images';
import { assertImageForCustomer } from './license';
import { compareVersions, isDirectory } from './manifest';
import { assertImageKeys } from './pkgcmd';
import { ensureFrameCsp } from './nginxCsp';
import { ensureProxyTrust } from './secrets';
import { composeFile, requireState, writeProjectEnv, writeState, type State } from './state';
import { CrmctlError, type Deps } from './types';
import { embeddedCustomer, keepManifest, verifyAndUnpack } from './verify';

const prevComposeDir = (deps: Deps) => path.join(deps.paths.libDir, 'compose.prev');

/** Кандидат: новый app рядом со старым, без публикации портов и без трафика (проверка изнутри сети). */
async function checkCandidate(deps: Deps, version: string, waitMs: number): Promise<void> {
  await deps.exec.run('docker', ['rm', '-f', CANDIDATE_NAME]);
  const run = await deps.exec.run('docker', [
    'run', '-d', '--name', CANDIDATE_NAME,
    '--network', 'crm_internal',
    '--env-file', path.join(deps.paths.etcDir, 'app.env'),
    '--read-only', '--tmpfs', '/tmp:size=64m,mode=1777', '--tmpfs', '/app/.next/cache:size=64m,uid=1000,gid=1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    `crm-app:${version}`,
  ]);
  try {
    if (run.code !== 0) throw new CrmctlError(`Кандидат не запущен: ${describe(run)}`);
    const h = await waitHealthy(deps, () => probeCandidate(deps, version), waitMs);
    if (!h.ok) throw new CrmctlError(`Новая версия не прошла /api/health до переключения (${h.detail}); прежняя продолжает работать`);
  } finally {
    await deps.exec.run('docker', ['rm', '-f', CANDIDATE_NAME]);
  }
}

/** Вернуть прежнюю версию: compose, project.env, state. true — прежняя версия здорова. */
export async function restoreVersion(deps: Deps, original: State, waitMs: number, restoreCompose: boolean): Promise<boolean> {
  const { paths } = deps;
  if (restoreCompose && (await isDirectory(prevComposeDir(deps)))) {
    await cp(prevComposeDir(deps), path.dirname(composeFile(paths)), { recursive: true });
  }
  await writeProjectEnv(paths, original.current.version, original.current.buildId, original.hostPort);
  await writeState(paths, original);
  const up = await compose(deps, original.current.version, ['up', '-d', '--no-deps', 'app', 'worker']);
  if (up.code !== 0) deps.io.err(`compose up при откате: ${describe(up)}`);
  const h = await waitHealthy(deps, () => probeHost(deps, original.hostPort, original.current.version), waitMs);
  return up.code === 0 && h.ok;
}

export async function update(deps: Deps, args: ParsedArgs): Promise<number> {
  const pkg = args.positional[0];
  if (!pkg) throw new CrmctlError('Использование: crmctl update <пакет.tar.zst | каталог>', 2);
  const waitMs = intFlag(args.flags, 'wait-seconds', 90) * 1000;
  const recheckMs = intFlag(args.flags, 'recheck-seconds', 120) * 1000;
  const { io, paths } = deps;
  const original = await requireState(paths);
  const old = original.current.version;

  io.out('[1/7] Пакет и подпись');
  // До этой проверки ни docker, ни /etc/crm, ни compose/, ни state.json не трогаются (D-315, §4.1)
  const embedded = embeddedCustomer();
  const pk = await verifyAndUnpack(deps, pkg, {
    write: true,
    sig: typeof args.flags.sig === 'string' ? args.flags.sig : undefined,
    check: (m) => {
      if (m.customer !== original.customer || (embedded && m.customer !== embedded)) {
        throw new CrmctlError(`Пакет для другого клиента: ${m.customer}`);
      }
      const cmp = compareVersions(m.version, old);
      if (cmp === 0) throw new CrmctlError(`Версия ${m.version} уже установлена`);
      if (cmp < 0) throw new CrmctlError(`Пакет ${m.version} старше установленной ${old}; для возврата — crmctl rollback`);
      if (m.minFromVersion && compareVersions(old, m.minFromVersion) < 0) {
        throw new CrmctlError(`Обновление возможно с ${m.minFromVersion} и выше, установлена ${old}`);
      }
    },
  });
  const { dir, manifest } = pk;
  await keepManifest(deps, pk);
  const version = manifest.version;
  const schemaNow = await currentSchema(deps, old);
  if (manifest.schemaVersion < schemaNow) {
    throw new CrmctlError(`Схема пакета (${manifest.schemaVersion}) ниже текущей (${schemaNow})`);
  }

  io.out('[2/7] Образы и лицензия новым образом');
  await loadImages(deps, dir, manifest);
  // Ядро образа несёт водяной знак клиента и время сборки из манифеста; crmctl образа — ключи из манифеста
  await assertImageForCustomer(deps, `crm-app:${version}`, manifest.customer, 'Образ не принят', manifest.builtAt);
  await assertImageKeys(deps, `crm-app:${version}`, manifest);
  const lic = await deps.verifier.verifyLicense({
    image: `crm-app:${version}`,
    licenseDir: path.join(paths.libDir, 'license'),
    installId: original.installId,
  });
  if (!lic.ok) throw new CrmctlError(`Лицензия не принята новым образом: ${lic.reason}. Прежняя версия работает`);
  if (lic.warning) io.out(`Внимание: ${lic.warning}`);

  io.out('[3/7] Миграции: копия и накатка');
  const pending = await pendingMigrations(deps, version);
  if (pending === 'pending') {
    const b = await deps.exec.run(paths.backupCmd, []);
    if (b.code !== 0) throw new CrmctlError(`Копия БД не сделана, обновление остановлено: ${describe(b)}`);
    io.out(await runMigrate(deps, version));
  } else {
    io.out('Новых миграций нет.');
  }
  await applyGrants(deps, version);

  // Недостающие обязательные строки окружения (CRM_PROXY_SECRET, D-155) и include секрета в nginx: до
  // кандидата — новая версия без секрета в production не стартует. Прежней версии они не мешают.
  await ensureProxyTrust(deps);
  await ensureFrameCsp(deps);

  io.out('[4/7] Проверка новой версии рядом со старой');
  await checkCandidate(deps, version, waitMs);

  io.out('[5/7] Переключение');
  await rm(prevComposeDir(deps), { recursive: true, force: true });
  await cp(path.dirname(composeFile(paths)), prevComposeDir(deps), { recursive: true });
  const newCompose = path.join(dir, 'compose');
  const replaceCompose = await isDirectory(newCompose);
  if (replaceCompose) await cp(newCompose, path.dirname(composeFile(paths)), { recursive: true });
  const next: State = {
    ...original,
    current: { version, buildId: manifest.buildId, switchedAt: deps.now(), manifestSha256: pk.manifestSha256, kid: pk.kid, verified: pk.verified },
    previous: {
      version: old,
      buildId: original.current.buildId,
      ...(original.current.manifestSha256 ? { manifestSha256: original.current.manifestSha256 } : {}),
      ...(original.current.kid !== undefined ? { kid: original.current.kid } : {}),
      ...(original.current.verified ? { verified: original.current.verified } : {}),
    },
  };
  await writeProjectEnv(paths, version, manifest.buildId, original.hostPort);
  await writeState(paths, next);
  const failRollback = async (why: string): Promise<number> => {
    io.err(`${why}. Автооткат на ${old}`);
    const ok = await restoreVersion(deps, original, waitMs, replaceCompose);
    if (ok) {
      io.err(`Откат выполнен: работает ${old}. БД не откатывалась: схема новая, прежняя версия её читает`);
      return 1;
    }
    io.err(`ОТКАТ НЕ УДАЛСЯ: ${old} не отвечает на /api/health. Нужно вмешательство: crmctl status, docker compose -p crm logs`);
    return 2;
  };
  const up = await compose(deps, version, ['up', '-d', '--no-deps', 'app', 'worker']);
  if (up.code !== 0) return failRollback(`compose up: ${describe(up)}`);

  io.out('[6/7] Проверка после переключения');
  const h1 = await waitHealthy(deps, () => probeHost(deps, original.hostPort, version), waitMs);
  if (!h1.ok) return failRollback(`/api/health после переключения: ${h1.detail}`);
  const w1 = await waitHealthy(deps, () => probeWorker(deps, version), waitMs);
  if (!w1.ok) return failRollback(`${w1.detail} после переключения`);
  await deps.sleep(recheckMs);
  const h2 = await probeHost(deps, original.hostPort, version);
  if (!h2.ok) return failRollback(`/api/health через ${Math.round(recheckMs / 1000)} с: ${h2.detail}`);
  const w2 = await probeWorker(deps, version);
  if (!w2.ok) return failRollback(`${w2.detail} через ${Math.round(recheckMs / 1000)} с`);

  io.out('[7/7] Готово');
  await syncCli(deps, version);
  io.out(`Работает ${version} (прежняя ${old} сохранена для crmctl rollback).`);
  return 0;
}
