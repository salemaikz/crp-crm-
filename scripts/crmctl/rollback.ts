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
import { checkSignature, isStand, keysSubset, loadKeySet, releaseKeyList, sha256, type KeySet } from './verify';
import { composeFile, requireState, type State } from './state';
import { CrmctlError, type Deps, type PackageManifest } from './types';

type Target = NonNullable<State['previous']>;
/** Запись о проверке подписи версии, как её пишет update (manifestSha256, kid, verified). */
type VerifyRecord = Pick<Target, 'manifestSha256' | 'kid' | 'verified'>;

interface Stored {
  manifest: PackageManifest | null;
  /** Запись о проверке, восстановленная задним числом для версии, поставленной до O4c. */
  backfill: VerifyRecord | null;
}

const LEGACY_HINT = 'порядок — docs/ops/RUNBOOK.md, RUNBOOK «Откат на версию до O4c»';

/**
 * Версия поставлена прежним crmctl (до O4c): в state.json нет записи о проверке. Откат разрешён, если в
 * packages/<клиент>-<версия> лежит manifest.json этой версии и сборки с подписью, проходящей текущими ключами;
 * Id образа сверяется дальше так же, как для обычной записи. Запись (manifestSha256, kid) дописывается в state.
 */
function legacyCheck(set: KeySet, customer: string, target: Target, dir: string, mbytes: Buffer | null, sigText: string | null): { problem: string | null; manifest: PackageManifest | null; backfill: VerifyRecord | null } {
  const why = (p: string) => `версия поставлена до проверки подписи (O4c), ${p}; ${LEGACY_HINT}`;
  if (mbytes === null) return { problem: why(`подписанного manifest.json в ${dir} нет`), manifest: null, backfill: null };
  if (sigText === null) return { problem: why('сохранённой подписи нет'), manifest: null, backfill: null };
  let kid: string;
  let manifest: PackageManifest;
  try {
    kid = checkSignature(set, mbytes, sigText);
    manifest = parseManifest(mbytes);
  } catch (e) {
    return { problem: why(e instanceof Error ? e.message : String(e)), manifest: null, backfill: null };
  }
  if (manifest.customer !== customer || manifest.version !== target.version) {
    return { problem: why('сохранённый manifest.json — для другой версии или клиента'), manifest: null, backfill: null };
  }
  if (manifest.buildId !== target.buildId) {
    return { problem: why('buildId манифеста не совпадает с записью в state.json'), manifest: null, backfill: null };
  }
  return { problem: null, manifest, backfill: { manifestSha256: sha256(mbytes), kid, verified: 'signature' } };
}

/**
 * §4.4: перед откатом перепроверяется то, что сохранил `update`: manifest.json в packages/ совпадает с записью
 * в state.json, подпись проходит текущим доверенным набором, Id образа равен digest. Нет записи (версия до O4c) —
 * см. legacyCheck. Запись есть, но манифест изменён или ключ отозван — на бою откат запрещён (нужен пакет через
 * update), на стенде идёт с предупреждением.
 */
async function verifyStored(deps: Deps, customer: string, target: Target): Promise<Stored> {
  const stand = await isStand(deps);
  const dir = path.join(deps.paths.libDir, 'packages', `${customer}-${target.version}`);
  const mbytes = await readFile(path.join(dir, 'manifest.json')).catch(() => null);
  const sigText = await readFile(path.join(dir, 'manifest.sig'), 'utf8').catch(() => null);
  const set = await loadKeySet(deps);
  let problem: string | null = null;
  let manifest: PackageManifest | null = null;
  let backfill: VerifyRecord | null = null;
  const legacy = !target.manifestSha256 || !target.verified;
  if (legacy) {
    ({ problem, manifest, backfill } = legacyCheck(set, customer, target, dir, mbytes, sigText));
  } else {
    if (mbytes === null) problem = 'сохранённого manifest.json нет';
    else if (sha256(mbytes) !== target.manifestSha256) problem = 'сохранённый manifest.json изменён';
    else if (target.verified === 'stub') problem = 'версия была поставлена без проверки подписи (заглушка стенда)';
    else if (sigText === null) problem = 'сохранённой подписи нет';
    else {
      try {
        checkSignature(set, mbytes, sigText);
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
  }
  if (problem) {
    if (!stand) {
      // у версии до O4c путь — в RUNBOOK (LEGACY_HINT уже в тексте); у остальных — новый пакет через update
      throw new CrmctlError(`Откат на ${target.version} запрещён: ${problem}${legacy ? '' : '. Нужен пакет через crmctl update'}`);
    }
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
  return { manifest, backfill };
}

export async function rollback(deps: Deps, args: ParsedArgs): Promise<number> {
  const waitMs = intFlag(args.flags, 'wait-seconds', 90) * 1000;
  const state = await requireState(deps.paths);
  if (!state.previous) throw new CrmctlError('Откатываться некуда: прежняя версия не записана');
  const target = state.previous;
  if (!(await imageExists(deps, `crm-app:${target.version}`))) {
    throw new CrmctlError(`Образа crm-app:${target.version} нет на сервере (почищен?). Загрузите пакет через crmctl update`);
  }
  const { manifest: stored, backfill } = await verifyStored(deps, state.customer, target);
  await assertImageForCustomer(deps, `crm-app:${target.version}`, state.customer, `Откат на ${target.version} невозможен`, stored?.builtAt);
  if (backfill) deps.io.out(`Версия ${target.version} поставлена до O4c: запись о проверке подписи ${target.version} восстановлена по сохранённому manifest.json (ключ ${backfill.kid}).`);
  deps.io.out(`Откат ${state.current.version} -> ${target.version}`);
  deps.io.out('Внимание: правки настроек, сделанные версией ' + state.current.version + ', после отката не видны (D-060).');
  const next: State = {
    ...state,
    current: { ...target, ...(backfill ?? {}), switchedAt: deps.now() },
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
