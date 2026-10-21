// SQL лицензии: одна строка license_state (id = 1). Платформа без домена (D-011): SQL лежит здесь.
import { license as coreLicense } from '@crm/core';
import type { LicenseStatus } from '@crm/core/license';
import type { Sql } from '../db';

/** Всё, что идёт в BIGINT, — целые мс: дробь (performance.now()) Postgres не примет (22P02, D-314). */
const ms = (n: number): number => coreLicense.wholeMs(n);
const msOrNull = (n: number | null): number | null => (n === null ? null : ms(n));

export type LicenseRow = {
  licenseRaw: string;
  installId: string;
  state: LicenseStatus;
  lastSeenAt: number;
  /** С P10 — момент последнего шага lastSeenAt по часам (правило часов, D-211). */
  checkedAt: number;
  invalidSince: number | null;
  reason: string;
  /** Эпизод «часы позади» (D-306, D-314): clock_real_at = начало + длительность эпизода, начало, показание часов
   *  на прошлом пересчёте; вне эпизода — NULL. */
  clockRealAt: number | null;
  clockBehindSince: number | null;
  clockBehindLast: number | null;
};

/** Строка лицензии под блокировкой (вызывать внутри db.tx). */
export async function lockLicenseRow(sql: Sql): Promise<LicenseRow | undefined> {
  const [row] = await sql<LicenseRow>`
    SELECT license_raw, install_id, state, last_seen_at, checked_at, invalid_since, reason,
           clock_real_at, clock_behind_since, clock_behind_last
      FROM license_state WHERE id = 1 FOR UPDATE`;
  return row;
}

export async function readLicenseRow(sql: Sql): Promise<LicenseRow | undefined> {
  const [row] = await sql<LicenseRow>`
    SELECT license_raw, install_id, state, last_seen_at, checked_at, invalid_since, reason,
           clock_real_at, clock_behind_since, clock_behind_last
      FROM license_state WHERE id = 1`;
  return row;
}

/**
 * Строки нет (разработка, тестовая БД, установка до P10): создаём с новым installId в состоянии missing.
 * На сервере installId создаёт crmctl install; здесь ON CONFLICT не перетирает его.
 */
export async function ensureLicenseRow(sql: Sql, installId: string, at: number): Promise<void> {
  await sql`
    INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
    VALUES (1, '', ${installId}, 'missing', ${ms(at)}, ${ms(at)})
    ON CONFLICT (id) DO NOTHING`;
}

export async function saveLicenseRow(sql: Sql, r: Omit<LicenseRow, 'installId'>): Promise<void> {
  await sql`
    UPDATE license_state
       SET license_raw = ${r.licenseRaw}, state = ${r.state}, last_seen_at = ${ms(r.lastSeenAt)},
           checked_at = ${ms(r.checkedAt)}, invalid_since = ${msOrNull(r.invalidSince)}, reason = ${r.reason},
           clock_real_at = ${msOrNull(r.clockRealAt)}, clock_behind_since = ${msOrNull(r.clockBehindSince)},
           clock_behind_last = ${msOrNull(r.clockBehindLast)}
     WHERE id = 1`;
}

/**
 * Сброс правила часов (crmctl license-clock reset --yes, D-314): время лицензии — показание часов, эпизода нет.
 * Вызывать внутри db.tx после lockLicenseRow.
 */
export async function resetLicenseClockRow(sql: Sql, at: number): Promise<void> {
  await sql`
    UPDATE license_state
       SET last_seen_at = ${ms(at)}, checked_at = ${ms(at)},
           clock_real_at = NULL, clock_behind_since = NULL, clock_behind_last = NULL
     WHERE id = 1`;
}
