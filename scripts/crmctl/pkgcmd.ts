// crmctl keys [--json] и crmctl package verify <архив|каталог> [--sig F] (docs/ops/release-design.md §4.6).
// Обе команды только читают: ни docker, ни записи на диск. Ядро не нужно, поэтому работают на хосте.
import { strFlag, type ParsedArgs } from './args';
import { describe } from './compose';
import { keyFingerprint } from './package-format';
import { loadKeySet, releaseKeyList, sameKeys, verifyAndUnpack } from './verify';
import { CrmctlError, type Deps, type PackageManifest } from './types';

export async function keys(deps: Deps, args: ParsedArgs): Promise<number> {
  const set = await loadKeySet(deps);
  const release = releaseKeyList(set);
  const stage = Object.entries(set.raw.stage)
    .map(([kid, b64]) => ({ kid, sha256: keyFingerprint(b64) }))
    .sort((a, b) => (a.kid < b.kid ? -1 : 1));
  if (args.flags.json) {
    deps.io.out(JSON.stringify({ release, stage }));
    return 0;
  }
  deps.io.out(`Ключи релизов (вшиты в crmctl): ${release.length}`);
  for (const k of release) deps.io.out(`  ${k.kid}  ${k.sha256}`);
  if (set.stand) {
    deps.io.out(`Ключи стенда (stage-keys.json): ${stage.length}`);
    for (const k of stage) deps.io.out(`  ${k.kid}  ${k.sha256}`);
  }
  return 0;
}

export async function packageCommand(deps: Deps, args: ParsedArgs): Promise<number> {
  const [sub, target] = args.positional;
  if (sub !== 'verify' || !target) throw new CrmctlError('Использование: crmctl package verify <архив|каталог> [--sig <файл>]', 2);
  const sig = args.flags.sig === undefined ? undefined : strFlag(args.flags, 'sig');
  const v = await verifyAndUnpack(deps, target, { sig, write: false });
  const { io } = deps;
  io.out(`клиент:   ${v.manifest.customer}`);
  io.out(`версия:   ${v.manifest.version}`);
  io.out(`ключ:     ${v.kid || '— (подпись не проверена, заглушка стенда)'}`);
  io.out(`файлов:   ${v.manifest.files.length}`);
  io.out(`манифест: sha256 ${v.manifestSha256}`);
  io.out(v.verified === 'signature' ? 'Пакет цел, подпись принята.' : 'Пакет цел; ПОДПИСЬ НЕ ПРОВЕРЕНА (заглушка стенда).');
  return 0;
}

/**
 * §4.2: crmctl НОВОГО образа несёт те же ключи релизов, что записаны в подписанном манифесте. Иначе syncCli
 * поставил бы на хост crmctl с ключами, которых владелец при подписи не видел.
 */
export async function assertImageKeys(deps: Deps, image: string, manifest: PackageManifest): Promise<void> {
  const r = await deps.exec.run('docker', [
    'run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', image, 'dist/crmctl.mjs', 'keys', '--json',
  ]);
  let parsed: { release?: { kid: string; sha256: string }[] };
  try {
    parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as typeof parsed;
  } catch {
    throw new CrmctlError(`Образ ${image} не сообщил ключи релизов: ${describe(r)}`);
  }
  if (!Array.isArray(parsed.release) || !sameKeys(parsed.release, manifest.releaseKeys)) {
    throw new CrmctlError(`Ключи релизов в crmctl образа ${image} не совпадают с подписанным manifest.json: пакет не принят`);
  }
}
