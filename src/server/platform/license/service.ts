// Пересчёт состояния лицензии (ARCHITECTURE §8.4, D-029, D-211). Вызывают: доступ (currentLicenseState,
// не чаще раза в минуту на процесс), воркер (задача `license` при старте и раз в час).
// Источник текста: файл LICENSE_PATH (его пишет `crmctl license install`), иначе копия в license_state
// (восстановление из копии БД на новой ВМ работает без файла). Файл не годится (битый, подменён, чужой,
// срок не начался) — вердикт по копии, как без файла (D-290). Проверка — ядро: подпись, установка,
// водяной знак, правило часов, состояния. Льгота `invalid` — только лицензии прежней сборки, до builtAt + 7 сут
// и не дальше срока подписанной копии (D-290): правка state/invalid_since/last_seen_at в обход crmctl
// «только чтение» не снимает и не продлевает. Запись — под
// блокировкой строки: несколько процессов не сдвигают часы дважды. Аудит — на новую лицензию, смену состояния,
// шаг при скачке часов вперёд и часы позади (начало эпизода и раз в сутки, D-306).
// Часы позади (D-306): опора монотонного времени процесса — в памяти процесса (ниже), оценка и эпизод — в
// license_state; первый пересчёт после старта (без опоры) двигает время не меньше чем на шаг CLOCK_RESTART_STEP_MS.
import { license as coreLicense } from '@crm/core';
import type { ClockAnchor, Evaluation, InvalidReason, LicenseStatus, Verdict } from '@crm/core/license';
import { writeAudit } from '../audit';
import { newId, type Db } from '../db';
import type { LicenseEnv } from './env';
import { ensureLicenseRow, lockLicenseRow, saveLicenseRow } from './repo';

const { advanceClock, evaluateLicense, missingAllowed, verifyLicense, verifyStoredCopy } = coreLicense;

export type LicenseSnapshot = Evaluation & {
  installId: string;
  /** Эффективное «сейчас», по которому оценено состояние. */
  now: number;
  /** Скачок часов при этой проверке (тревога администратору — P10b). */
  clockJump: 'none' | 'backward' | 'forward';
  /** Откуда текст лицензии: файл, копия в БД или нет вовсе. */
  source: 'file' | 'db' | 'none';
  /** Файл есть, но не годится и вердикт взят по копии в БД: почему; иначе null. */
  fileReason: InvalidReason | null;
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

export async function refreshLicense(db: Db, env: LicenseEnv): Promise<LicenseSnapshot> {
  const fileText = await env.readFile();
  const clock = env.clock();
  const mono = env.mono();
  const anchor = g.__crmLicenseClockAnchor ?? null;
  let nextAnchor: ClockAnchor | null = null;
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
    const behind =
      row.clockBehindSince !== null && row.clockBehindLast !== null ? { since: row.clockBehindSince, lastClock: row.clockBehindLast } : null;
    const c = advanceClock({ clock, lastSeenAt: row.lastSeenAt, lastStepAt: row.checkedAt, realAt: row.clockRealAt, behind, mono, anchor });
    nextAnchor = c.anchor;

    // Файл годится — по нему. Не годится, а в БД другая копия — вердикт по копии, как без файла (D-290):
    // подмена или порча файла не отнимает работу у подписанной копии и не даёт льготы сверх неё.
    const fileVerdict = fromFile === null ? null : verifyLicense(fromFile, expect);
    let raw = fromFile;
    let verdict = fileVerdict;
    let fileReason: InvalidReason | null = null;
    if (!usable(fileVerdict, c.now) && stored !== null && stored !== fromFile) {
      if (fileVerdict !== null) fileReason = reasonOf(fileVerdict, c.now);
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
      clockRealAt: c.realAt,
      clockBehindSince: c.behind?.since ?? null,
      clockBehindLast: c.behind?.lastClock ?? null,
    });

    const at = clock;
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
    if (fileReason !== null) {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_file_rejected', reason: fileReason }));
    }
    if (c.jump !== 'none') {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_clock_jump', direction: c.jump, stepped: c.stepped, locked: c.locked }));
    }
    return { ...e, installId: row.installId, now: c.now, clockJump: c.jump, source, fileReason };
  });
  // Опора — только после записи: несохранённый пересчёт не должен учитываться дважды
  g.__crmLicenseClockAnchor = nextAnchor;
  return snap;
}
