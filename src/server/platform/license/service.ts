// Пересчёт состояния лицензии (ARCHITECTURE §8.4, D-029, D-211). Вызывают: доступ (currentLicenseState,
// не чаще раза в минуту на процесс), воркер (задача `license` при старте и раз в час).
// Источник текста: файл LICENSE_PATH (его пишет `crmctl license install`), иначе копия в license_state
// (восстановление из копии БД на новой ВМ работает без файла). Проверка — ядро: подпись, установка,
// водяной знак, правило часов, состояния. Льгота `invalid` опирается только на подписанную копию license_raw
// (D-290): правка state/invalid_since/last_seen_at в обход crmctl «только чтение» не снимает. Запись — под
// блокировкой строки: несколько процессов не сдвигают часы дважды. Аудит — на новую лицензию, смену состояния
// и шаг при скачке часов.
import { license as coreLicense } from '@crm/core';
import type { Evaluation, LicenseStatus } from '@crm/core/license';
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
};

export async function refreshLicense(db: Db, env: LicenseEnv): Promise<LicenseSnapshot> {
  const fileText = await env.readFile();
  const clock = env.clock();
  return db.tx(async (sql) => {
    let row = await lockLicenseRow(sql);
    if (!row) {
      await ensureLicenseRow(sql, newId(), clock);
      row = await lockLicenseRow(sql);
      if (!row) throw new Error('license_state: строка не создана');
    }
    const fromFile = fileText !== null && fileText.trim() !== '' ? fileText.trim() : null;
    const raw = fromFile ?? (row.licenseRaw.trim() !== '' ? row.licenseRaw.trim() : null);
    const source: LicenseSnapshot['source'] = fromFile ? 'file' : raw ? 'db' : 'none';

    const expect = { installId: row.installId, keys: env.keys, watermark: env.watermark };
    const verdict = raw === null ? null : verifyLicense(raw, expect);
    const c = advanceClock({ clock, lastSeenAt: row.lastSeenAt, lastStepAt: row.checkedAt });
    const previous: LicenseStatus = row.state;
    const e = evaluateLicense({
      verdict,
      now: c.now,
      previous,
      invalidSince: row.invalidSince,
      lastSeenAt: row.lastSeenAt,
      // Опора льготы invalid — только подписанная копия в БД, а не state/invalid_since строки (D-290)
      anchor: verdict === null ? null : verifyStoredCopy(row.licenseRaw, expect),
      allowMissing: missingAllowed(env.watermark),
    });

    // Копия в БД — только проверенная подписью и уже действующая лицензия: битый файл и лицензия «на будущее»
    // не затирают рабочую копию (она — опора льготы invalid)
    const licenseRaw = verdict?.ok && e.status !== 'invalid' && raw !== null ? raw : row.licenseRaw;
    await saveLicenseRow(sql, {
      licenseRaw,
      state: e.status,
      lastSeenAt: c.lastSeenAt,
      checkedAt: c.lastStepAt,
      invalidSince: e.invalidSince,
      reason: e.reason,
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
    if (e.status !== previous || (e.reason !== row.reason && e.status === 'invalid')) {
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
    if (c.jump !== 'none') {
      console.warn(JSON.stringify({ level: 'warn', code: 'license_clock_jump', direction: c.jump, stepped: c.stepped }));
    }
    return { ...e, installId: row.installId, now: c.now, clockJump: c.jump, source };
  });
}
