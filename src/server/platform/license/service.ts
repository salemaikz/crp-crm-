// Пересчёт состояния лицензии (ARCHITECTURE §8.4, D-029, D-211). Вызывают: доступ (currentLicenseState,
// не чаще раза в минуту на процесс), воркер (задача `license` при старте и раз в час).
// Источник текста: файл LICENSE_PATH (его пишет `crmctl license install`), иначе копия в license_state
// (восстановление из копии БД на новой ВМ работает без файла). Файл не годится (битый, подменён, чужой,
// срок не начался) или не читается (каталог, канал, нет прав) — вердикт по копии, как без файла (D-290, D-054).
// Проверка — ядро: подпись, установка, водяной знак, правило часов, состояния. Льгота `invalid` — только лицензии прежней сборки, до builtAt + 7 сут
// и не дальше срока подписанной копии (D-290): правка state/invalid_since/last_seen_at в обход crmctl
// «только чтение» не снимает и не продлевает. Запись — под
// блокировкой строки: несколько процессов не сдвигают часы дважды. Аудит — на новую лицензию, смену состояния,
// шаг при скачке часов вперёд и часы позади (начало эпизода и раз в сутки, D-306).
// Часы позади (D-306, D-314): длительность эпизода — в license_state (clock_real_at − clock_behind_since), опора
// монотонного времени процесса — в памяти процесса (ниже). Всё, что пишется в BIGINT, — целые мс (wholeMs в ядре и
// в repo.ts). Ошибка пересчёта отсюда бросается; доступ получает «только чтение» с причиной error (current.ts).
import { license as coreLicense } from '@crm/core';
import type { ClockAnchor, ClockBehind, Evaluation, InvalidReason, LicenseStatus, Verdict } from '@crm/core/license';
import { writeAudit } from '../audit';
import { newId, type Db } from '../db';
import type { LicenseEnv } from './env';
import { ensureLicenseRow, lockLicenseRow, saveLicenseRow, type LicenseRow } from './repo';
import { restoreRuntimeSignal, takeRuntimeSignal } from './runtime';

const { advanceClock, evaluateLicense, missingAllowed, verifyLicense, verifyStoredCopy } = coreLicense;

export type LicenseSnapshot = Evaluation & {
  installId: string;
  /** Эффективное «сейчас», по которому оценено состояние. */
  now: number;
  /** Скачок часов при этой проверке (тревога администратору — P10b). */
  clockJump: 'none' | 'backward' | 'forward';
  /** Откуда текст лицензии: файл, копия в БД или нет вовсе. */
  source: 'file' | 'db' | 'none';
  /** Файл есть, но не годится и вердикт взят по копии в БД (`unreadable` — не читается, тогда как без файла): почему; иначе null. */
  fileReason: InvalidReason | 'unreadable' | null;
};

type AnchorGlobal = typeof globalThis & { __crmLicenseClockAnchor?: ClockAnchor | null };
const g = globalThis as AnchorGlobal;

/** Опора правила часов этого процесса теряется (тесты: «перезапуск», testing.ts). */
export function forgetProcessClock(): void {
  g.__crmLicenseClockAnchor = null;
}

/** Лицензия подписью сходится и уже действует. */
const usable = (v: Verdict | null, now: number): boolean => v !== null && v.ok && now >= v.license.notBefore;
const reasonOf = (v: Verdict, now: number): InvalidReason => (v.ok ? (now < v.license.notBefore ? 'not_yet_valid' : 'malformed') : v.reason);

/**
 * Текст файла; не читается (каталог, канал, нет прав, EIO) — как без файла (D-054, D-290): вердикт по копии в БД,
 * а не исключение, иначе порча файла клала бы в 500 и выгрузку, и мутации безопасности. Наружу — только код ошибки.
 */
async function readFileText(env: LicenseEnv): Promise<{ text: string | null; unreadable: string | null }> {
  try {
    return { text: await env.readFile(), unreadable: null };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return { text: null, unreadable: typeof code === 'string' && /^E[A-Z0-9]{1,15}$/.test(code) ? code : 'unknown' };
  }
}

/** Эпизод «часы позади» из строки: длительность — clock_real_at − clock_behind_since (не меньше 0). */
function behindOf(row: LicenseRow): ClockBehind | null {
  if (row.clockBehindSince === null || row.clockBehindLast === null) return null;
  const forMs = Math.max(0, (row.clockRealAt ?? row.clockBehindSince) - row.clockBehindSince);
  return { since: row.clockBehindSince, lastClock: row.clockBehindLast, forMs };
}

export async function refreshLicense(db: Db, env: LicenseEnv): Promise<LicenseSnapshot> {
  const { text: fileText, unreadable } = await readFileText(env);
  const clock = env.clock();
  const mono = env.mono();
  const anchor = g.__crmLicenseClockAnchor ?? null;
  let nextAnchor: ClockAnchor | null = null;
  // Сигнал проверки запуска (D-314): в аудит один раз на процесс, вместе с пересчётом
  const signal = takeRuntimeSignal();
  const snap = await db.tx(async (sql) => {
    let row = await lockLicenseRow(sql);
    if (!row) {
      await ensureLicenseRow(sql, newId(), clock);
      row = await lockLicenseRow(sql);
      if (!row) throw new Error('license_state: строка не создана');
    }
    const fromFile = fileText !== null && fileText.trim() !== '' ? fileText.trim() : null;
    const stored = row.licenseRaw.trim() !== '' ? row.licenseRaw.trim() : null;
    const expect = { installId: row.installId, keys: env.keys, watermark: env.watermark };
    const behind = behindOf(row);
    const c = advanceClock({ clock, lastSeenAt: row.lastSeenAt, lastStepAt: row.checkedAt, behind, mono, anchor });
    nextAnchor = c.anchor;

    // Файл годится — по нему. Не годится, а в БД другая копия — вердикт по копии, как без файла (D-290):
    // подмена или порча файла не отнимает работу у подписанной копии и не даёт льготы сверх неё.
    const fileVerdict = fromFile === null ? null : verifyLicense(fromFile, expect);
    let raw = fromFile;
    let verdict = fileVerdict;
    let fileReason: LicenseSnapshot['fileReason'] = null;
    if (!usable(fileVerdict, c.now) && stored !== null && stored !== fromFile) {
      if (fileVerdict !== null) fileReason = reasonOf(fileVerdict, c.now);
      else if (unreadable !== null) fileReason = 'unreadable';
      raw = stored;
      verdict = verifyLicense(stored, expect);
    }
    const source: LicenseSnapshot['source'] = raw === null ? 'none' : raw === fromFile ? 'file' : 'db';

    const previous: LicenseStatus = row.state;
    const e = evaluateLicense({
      verdict,
      now: c.now,
      previous,
      invalidSince: row.invalidSince,
      // Опора льготы wrong_build — подписанная копия в БД и время сборки из водяного знака (D-290)
      anchor: verdict === null ? null : verifyStoredCopy(row.licenseRaw, expect),
      builtAt: env.watermark.builtAt,
      allowMissing: missingAllowed(env.watermark),
      clockLocked: c.locked,
    });

    // Копия в БД — только проверенная подписью и уже действующая лицензия: битый файл и лицензия «на будущее»
    // не затирают рабочую копию (она — вердикт при негодном файле и опора льготы wrong_build)
    const licenseRaw = verdict?.ok && e.status !== 'invalid' && raw !== null ? raw : row.licenseRaw;
    await saveLicenseRow(sql, {
      licenseRaw,
      state: e.status,
      lastSeenAt: c.lastSeenAt,
      checkedAt: c.lastStepAt,
      invalidSince: e.invalidSince,
      reason: e.reason,
      // Эпизод хранится как начало и «начало + длительность»; вне эпизода — NULL (D-314)
      clockRealAt: c.behind ? c.behind.since + c.behind.forMs : null,
      clockBehindSince: c.behind?.since ?? null,
      clockBehindLast: c.behind?.lastClock ?? null,
    });

    const at = coreLicense.wholeMs(clock);
    if (verdict?.ok && licenseRaw !== row.licenseRaw) {
      await writeAudit(sql, {
        actorId: null,
        action: 'license.install',
        entity: 'license',
        entityId: verdict.license.lid,
        meta: { kid: verdict.license.kid, expiresAt: verdict.license.expiresAt, graceDays: verdict.license.graceDays, source },
        createdAt: at,
      });
    }
    if (e.status !== previous || (e.reason !== row.reason && (e.status === 'invalid' || e.status === 'read_only'))) {
      await writeAudit(sql, {
        actorId: null,
        action: 'license.state_change',
        entity: 'license',
        entityId: row.installId,
        meta: { from: previous, to: e.status, access: e.access, reason: e.reason },
        createdAt: at,
      });
    }
    if (c.jump === 'forward' && c.stepped) {
      await writeAudit(sql, {
        actorId: null,
        action: 'license.clock_jump',
        entity: 'license',
        entityId: row.installId,
        meta: { direction: 'forward', aheadHours: Math.floor((clock - row.lastSeenAt) / 3_600_000) },
        createdAt: at,
      });
    }
    if (c.alert) {
      // Часы позади: начало эпизода и раз в сутки, пока длится (через 48 ч — «только чтение», причина clock)
      await writeAudit(sql, {
        actorId: null,
        action: 'license.clock_jump',
        entity: 'license',
        entityId: row.installId,
        meta: { direction: 'backward', behindHours: Math.floor((c.now - clock) / 3_600_000), episodeHours: Math.floor(c.behindForMs / 3_600_000), locked: c.locked },
        createdAt: at,
      });
    }
    if (signal !== null) {
      await writeAudit(sql, {
        actorId: null,
        action: 'license.runtime_signal',
        entity: 'license',
        entityId: row.installId,
        meta: { role: signal.role, codes: signal.codes },
        createdAt: at,
      });
    }
    if (unreadable !== null) {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_file_rejected', reason: 'unreadable', errno: unreadable }));
    } else if (fileReason !== null) {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_file_rejected', reason: fileReason }));
    }
    if (c.jump !== 'none') {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_clock_jump', direction: c.jump, stepped: c.stepped, locked: c.locked }));
    }
    return { ...e, installId: row.installId, now: c.now, clockJump: c.jump, source, fileReason };
  }).catch((err: unknown) => {
    if (signal !== null) restoreRuntimeSignal(signal);
    throw err;
  });
  // Опора — только после записи: несохранённый пересчёт не должен учитываться дважды
  g.__crmLicenseClockAnchor = nextAnchor;
  return snap;
}
