// crmctl license install <файл> | status | verify <файл> <installId>  (ARCHITECTURE §8.4, DEPLOY §4 п. 4, D-211).
//
// install — проверить лицензию ядром ТЕКУЩЕГО образа (ключи и водяной знак вшиты в него при сборке), сверить
//   клиента и срок, затем атомарно положить в <libDir>/license/license.crm (прежняя — license.crm.prev).
//   Приложение и воркер читают файл (том только для чтения) и применяют его в течение минуты; загрузку
//   пишет в аудит само приложение (license.install). Мутация безопасности D-054: работает в любом состоянии.
// status  — что лежит в файле, что о нём думает ядро образа и что записано в license_state.
// verify  — служебная: запускается ВНУТРИ образа (`docker run … node dist/crmctl.mjs license verify`),
//   печатает одну строку JSON. На хосте ядро не используется для проверки подписи: ключи — в ядре образа.
//
// Регистрация в реестре (scripts/crmctl/index.ts, зона ops): `commands.license = license` и строка в USAGE;
// проверка лицензии в `update` — `verifier.verifyLicense = imageLicenseVerifier(deps).verifyLicense`.
import { copyFile, mkdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { license as coreLicense } from '@crm/core';
import type { InvalidReason, LicensePayload, TrustedKeys, Watermark } from '@crm/core/license';
import type { ParsedArgs } from './args';
import { describe, psql } from './compose';
import { requireState } from './state';
import { CrmctlError, type Deps, type Verdict } from './types';

export const LICENSE_FILE = 'license.crm';
/** Где файл виден внутри одноразового контейнера проверки. */
const CHECK_MOUNT = '/tmp/license-check.crm';
const MAX_BYTES = 16 * 1024;
const DAY = 86_400_000;
/** Как INVALID_GRACE_DAYS ядра: хостовая копия crmctl ядро не вшивает (build-cli.mjs). */
const BUILD_GRACE_DAYS = 7;

export const licenseDir = (deps: Deps) => path.join(deps.paths.libDir, 'license');

/** Ответ `license verify` из образа. */
export type ImageVerdict = {
  ok: boolean;
  reason?: InvalidReason | 'missing' | 'unreadable';
  watermark: Watermark;
  license?: Pick<LicensePayload, 'lid' | 'kid' | 'customer' | 'installId' | 'notBefore' | 'expiresAt' | 'graceDays' | 'features'> & {
    seats?: number;
    buildId?: string;
  };
};

/** Проверка текста лицензии ядром этого процесса (в образе — ядро с ключами клиента). */
export function verifyText(text: string | null, installId: string, env: { keys: TrustedKeys; watermark: Watermark }): ImageVerdict {
  if (text === null) return { ok: false, reason: 'missing', watermark: env.watermark };
  const v = coreLicense.verifyLicense(text, { installId, keys: env.keys, watermark: env.watermark });
  if (!v.ok) return { ok: false, reason: v.reason, watermark: env.watermark };
  const { lid, kid, customer, notBefore, expiresAt, graceDays, features, seats, buildId } = v.license;
  return {
    ok: true,
    watermark: env.watermark,
    license: {
      lid,
      kid,
      customer,
      installId: v.license.installId,
      notBefore,
      expiresAt,
      graceDays,
      features,
      ...(seats !== undefined ? { seats } : {}),
      ...(buildId !== undefined ? { buildId } : {}),
    },
  };
}

async function readSmall(file: string): Promise<string | null> {
  let s;
  try {
    s = await stat(file);
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  if (!s.isFile()) throw new CrmctlError(`${file}: не файл`);
  if (s.size > MAX_BYTES) throw new CrmctlError(`${file}: больше ${MAX_BYTES} байт — это не лицензия`);
  return (await readFile(file, 'utf8')).trim();
}

/**
 * Запуск проверки в образе: без сети, только чтение, файл смонтирован отдельно. hostFile = null — файла нет:
 * ничего не монтируем (docker создал бы на хосте каталог), ядро образа ответит «missing» и водяным знаком.
 */
export async function verifyInImage(deps: Deps, image: string, hostFile: string | null, installId: string): Promise<ImageVerdict> {
  const mount = hostFile === null ? [] : ['-v', `${path.resolve(hostFile)}:${CHECK_MOUNT}:ro`];
  const r = await deps.exec.run('docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    'node',
    ...mount,
    image,
    'dist/crmctl.mjs',
    'license',
    'verify',
    CHECK_MOUNT,
    installId,
  ]);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  let parsed: ImageVerdict;
  try {
    parsed = JSON.parse(line) as ImageVerdict;
  } catch {
    throw new CrmctlError(`Проверка лицензии в образе ${image} не ответила: ${describe(r)}`);
  }
  if (typeof parsed?.ok !== 'boolean' || typeof parsed.watermark !== 'object' || parsed.watermark === null) {
    throw new CrmctlError(`Проверка лицензии в образе ${image}: непонятный ответ`);
  }
  // Образ до D-290 времени сборки не сообщает: льготы для лицензии прежней сборки у него нет
  const builtAt = typeof parsed.watermark.builtAt === 'number' && Number.isSafeInteger(parsed.watermark.builtAt) ? parsed.watermark.builtAt : null;
  return { ...parsed, watermark: { ...parsed.watermark, builtAt } };
}

/** Конец льготы лицензии прежней сборки в этом образе: время сборки + 7 сут (D-290); null — без льготы. */
export function buildGraceEnd(wm: Watermark): number | null {
  return wm.builtAt === null ? null : wm.builtAt + BUILD_GRACE_DAYS * DAY;
}

/** Ядро образа должно быть собрано для клиента этой установки (водяной знак, D-028). */
function watermarkProblem(v: ImageVerdict, customer: string): string | null {
  if (v.watermark.customer === null) return 'ядро образа без водяного знака клиента (общая сборка) — на сервер клиента не ставится';
  if (v.watermark.customer !== customer) return `ядро образа собрано для клиента ${v.watermark.customer}, установка — ${customer}`;
  return null;
}

/**
 * `crmctl install`: ядро образа собрано для клиента пакета (D-213). Общий образ без водяного знака работает
 * без лицензии, поэтому на сервер клиента он не ставится. Файл лицензии не нужен: без него образ отвечает
 * «missing» и своим водяным знаком.
 */
export async function assertImageForCustomer(deps: Deps, image: string, customer: string): Promise<void> {
  const v = await verifyInImage(deps, image, null, 'watermark-check');
  const wm = watermarkProblem(v, customer);
  if (wm) throw new CrmctlError(`Образ не подходит для установки: ${wm}`);
}

const REASON_TEXT: Record<string, string> = {
  missing: 'файла нет',
  unreadable: 'файл не читается',
  malformed: 'это не лицензия CRM1 или файл повреждён',
  unsupported_version: 'формат лицензии новее этой версии',
  unknown_kid: 'ключ подписи не знаком этой сборке',
  test_key_in_client_build: 'подписана тестовым ключом',
  bad_signature: 'подпись не сходится',
  wrong_install: 'выдана для другой установки (installId)',
  wrong_customer: 'выдана другому клиенту',
  wrong_build: 'выдана для другой сборки',
  not_yet_valid: 'срок действия ещё не начался',
  expired: 'срок и льготный период закончились',
};
export const reasonText = (r: string | undefined) => (r ? (REASON_TEXT[r] ?? r) : '');

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function describeLicense(io: Deps['io'], l: NonNullable<ImageVerdict['license']>): void {
  io.out(`  номер:       ${l.lid} (ключ ${l.kid})`);
  io.out(`  клиент:      ${l.customer}`);
  io.out(`  действует:   ${day(l.notBefore)} — ${day(l.expiresAt)}, льгота ${l.graceDays} дн.`);
  io.out(`  модули:      ${l.features.join(', ') || '—'}${l.seats ? ` · мест: ${l.seats}` : ''}`);
}

async function install(deps: Deps, file: string | undefined): Promise<number> {
  if (!file) throw new CrmctlError('Использование: crmctl license install <файл>', 2);
  const { io } = deps;
  const st = await requireState(deps.paths);
  const text = await readSmall(file);
  if (text === null) throw new CrmctlError(`Файла ${file} нет`);
  // Формат и подпись проверяет ядро образа (ниже): хостовая копия crmctl запускается без ядра (build-cli.mjs)

  io.out(`[1/3] Проверка ядром образа crm-app:${st.current.version}`);
  const v = await verifyInImage(deps, `crm-app:${st.current.version}`, file, st.installId);
  const wm = watermarkProblem(v, st.customer);
  if (wm) throw new CrmctlError(`Лицензия не установлена: ${wm}`);
  if (!v.ok || !v.license) throw new CrmctlError(`Лицензия не принята: ${reasonText(v.reason)}`);
  if (v.license.customer !== st.customer) throw new CrmctlError(`Лицензия не принята: ${reasonText('wrong_customer')}`);

  io.out('[2/3] Срок');
  const now = deps.now();
  if (now < v.license.notBefore) throw new CrmctlError(`Лицензия не принята: ${reasonText('not_yet_valid')} (с ${day(v.license.notBefore)})`);
  const graceEnd = v.license.expiresAt + v.license.graceDays * DAY;
  if (now >= graceEnd) throw new CrmctlError(`Лицензия не принята: ${reasonText('expired')} (${day(graceEnd)})`);
  if (now >= v.license.expiresAt) io.out(`Внимание: срок уже прошёл, идёт льготный период до ${day(graceEnd)}`);
  else if (v.license.expiresAt - now < 14 * DAY) io.out(`Внимание: срок кончается ${day(v.license.expiresAt)}`);

  io.out('[3/3] Установка');
  const dir = licenseDir(deps);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, LICENSE_FILE);
  if ((await readSmall(target).catch(() => null)) !== null) await copyFile(target, `${target}.prev`);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${text}\n`, { mode: 0o644 });
  await chmod(tmp, 0o644);
  await rename(tmp, target);
  io.out('Лицензия установлена:');
  describeLicense(io, v.license);
  io.out('Приложение применит её в течение минуты. Проверка: crmctl license status');
  return 0;
}

type DbRow = { state?: string; reason?: string; last_seen_at?: number; checked_at?: number; invalid_since?: number | null };

async function status(deps: Deps): Promise<number> {
  const { io } = deps;
  const st = await requireState(deps.paths);
  const file = path.join(licenseDir(deps), LICENSE_FILE);
  io.out(`installId:     ${st.installId}`);
  io.out(`клиент:        ${st.customer}`);
  const text = await readSmall(file);
  if (text === null) {
    io.out(`файл:          нет (${file})`);
  } else {
    const v = await verifyInImage(deps, `crm-app:${st.current.version}`, file, st.installId);
    io.out(`файл:          ${file}`);
    io.out(`проверка:      ${v.ok ? 'подпись и установка сходятся' : `не принята — ${reasonText(v.reason)}`}`);
    const wm = watermarkProblem(v, st.customer);
    if (wm) io.out(`водяной знак:  ${wm}`);
    if (v.watermark.buildId) {
      io.out(`сборка образа: ${v.watermark.buildId}${v.watermark.builtAt !== null ? `, собрана ${new Date(v.watermark.builtAt).toISOString()}` : ''}`);
    }
    if (v.license) describeLicense(io, v.license);
    const end = buildGraceEnd(v.watermark);
    if (v.reason === 'wrong_build') {
      io.out(
        end === null
          ? 'льгота:        нет (образ без времени сборки) — нужна лицензия под эту сборку'
          : `льгота до:     ${new Date(end).toISOString()} (7 суток от сборки) — к этому сроку поставьте лицензию под эту сборку`,
      );
    }
  }
  const r = await psql(deps, st.current.version, 'SELECT row_to_json(l) FROM license_state l WHERE id = 1;');
  if (r.code !== 0) {
    io.out(`состояние:     БД не ответила (${describe(r)})`);
    return 1;
  }
  const line = r.stdout.trim();
  if (!line) {
    io.out('состояние:     строки license_state нет');
    return 0;
  }
  const row = JSON.parse(line) as DbRow;
  io.out(`состояние:     ${row.state ?? '?'}${row.reason ? ` (${reasonText(row.reason)})` : ''}`);
  if (row.last_seen_at) io.out(`часы лицензии: ${new Date(row.last_seen_at).toISOString()}`);
  if (row.invalid_since) io.out(`не сходится с: ${new Date(row.invalid_since).toISOString()}`);
  return 0;
}

/** Внутри образа: ключи и водяной знак — из ядра этого образа. Код выхода 0 — принята, 3 — нет. */
async function verifyCmd(deps: Deps, file: string | undefined, installId: string | undefined): Promise<number> {
  if (!file || !installId) throw new CrmctlError('Использование: crmctl license verify <файл> <installId>', 2);
  let text: string | null;
  try {
    text = await readSmall(file);
  } catch {
    deps.io.out(JSON.stringify({ ok: false, reason: 'unreadable', watermark: coreLicense.buildWatermark() } satisfies ImageVerdict));
    return 3;
  }
  const v = verifyText(text, installId, { keys: coreLicense.embeddedKeys(), watermark: coreLicense.buildWatermark() });
  deps.io.out(JSON.stringify(v));
  return v.ok ? 0 : 3;
}

export async function license(deps: Deps, args: ParsedArgs): Promise<number> {
  const [sub, a, b] = args.positional;
  if (sub === 'install') return install(deps, a);
  if (sub === 'status') return status(deps);
  if (sub === 'verify') return verifyCmd(deps, a, b);
  deps.io.err('Использование: crmctl license install <файл> | status');
  return 2;
}

/**
 * Проверка лицензии НОВЫМ образом до переключения (`crmctl update`, DEPLOY §5.2 п. 2). Нет файла — не
 * помеха (установка остаётся в missing). Отказ: подпись/установка не сходятся или ядро образа собрано
 * не для этого клиента. Лицензия прежней сборки (`wrong_build`) — не помеха, пока идут 7 суток от сборки
 * нового образа (D-290): лицензию под новую сборку `license install` примет только после переключения.
 */
export function imageLicenseVerifier(deps: Deps): { verifyLicense(input: { image: string; licenseDir: string; installId: string }): Promise<Verdict> } {
  return {
    async verifyLicense({ image, licenseDir: dir, installId }) {
      const st = await requireState(deps.paths);
      const file = path.join(dir, LICENSE_FILE);
      const exists = (await readSmall(file)) !== null;
      // Без файла проверяем только водяной знак: ответ «missing»
      const v = await verifyInImage(deps, image, exists ? file : null, installId);
      const wm = watermarkProblem(v, st.customer);
      if (wm) return { ok: false, reason: wm };
      if (!exists || v.ok) return { ok: true };
      if (v.reason === 'wrong_build') {
        const end = buildGraceEnd(v.watermark);
        if (end !== null && deps.now() < end) {
          return {
            ok: true,
            warning:
              `лицензия выдана для прежней сборки; сборка ${v.watermark.buildId ?? '?'} работает в льготе до ${new Date(end).toISOString()} ` +
              '(7 суток от сборки). До этого срока поставьте лицензию под новую сборку: crmctl license install',
          };
        }
        const why = end === null ? 'образ без времени сборки' : `7 суток от сборки истекли ${day(end)}`;
        return { ok: false, reason: `${reasonText('wrong_build')}, льготы нет (${why}); нужна лицензия без привязки к сборке` };
      }
      return { ok: false, reason: reasonText(v.reason) };
    },
  };
}
