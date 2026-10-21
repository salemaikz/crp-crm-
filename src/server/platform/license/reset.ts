// Сброс правила часов лицензии (D-314): `crmctl license-clock reset --yes` вместо psql. Нужен, когда часы сервера спешили
// больше чем на 48 ч и время лицензии ушло вперёд вместе с ними: после починки часов эпизод «часы позади» кончается
// сам, когда верные часы догонят last_seen_at, а сброс снимает его сразу.
// Сброс ставит время лицензии на показание часов — это откат времени лицензии назад. Поэтому он делается только
// при эпизоде (часы позади больше допуска), только с хоста под root (crmctl) и всегда оставляет запись
// license.clock_reset в аудите с величиной отката (часы) и тем, была ли блокировка. Root, переводящий часы назад,
// получает этим то же, что правкой license_state в psql (остаток D-306, D-314), но со следом в журнале.
import { license as coreLicense } from '@crm/core';
import { writeAudit } from '../audit';
import type { Db } from '../db';
import type { LicenseEnv } from './env';
import { lockLicenseRow, resetLicenseClockRow } from './repo';

const H = 3_600_000;

export type ClockResetResult = {
  /** reset — сброшено; not_behind — часы не позади времени лицензии, сбрасывать нечего; no_row — установки нет. */
  status: 'reset' | 'not_behind' | 'no_row';
  /** На сколько время лицензии откатилось назад (мс). */
  rewindMs: number;
  /** Была ли блокировка «часы позади» (эпизод дольше 48 ч). */
  wasLocked: boolean;
};

export async function resetLicenseClock(db: Db, env: Pick<LicenseEnv, 'clock'>): Promise<ClockResetResult> {
  const clock = coreLicense.wholeMs(env.clock());
  return db.tx(async (sql) => {
    const row = await lockLicenseRow(sql);
    if (!row) return { status: 'no_row', rewindMs: 0, wasLocked: false };
    const rewindMs = row.lastSeenAt - clock;
    if (rewindMs <= coreLicense.CLOCK_BACKWARD_TOLERANCE_MS) return { status: 'not_behind', rewindMs: 0, wasLocked: false };
    const since = row.clockBehindSince;
    const episodeMs = since === null ? 0 : Math.max(0, (row.clockRealAt ?? since) - since);
    const wasLocked = episodeMs > coreLicense.CLOCK_BEHIND_LOCK_MS;
    await resetLicenseClockRow(sql, clock);
    await writeAudit(sql, {
      actorId: null,
      action: 'license.clock_reset',
      entity: 'license',
      entityId: row.installId,
      meta: { rewindHours: Math.floor(rewindMs / H), episodeHours: Math.floor(episodeMs / H), wasLocked, by: 'crmctl' },
      createdAt: clock,
    });
    return { status: 'reset', rewindMs, wasLocked };
  });
}
