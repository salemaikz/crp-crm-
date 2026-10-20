// SQL лицензии: одна строка license_state (id = 1). Платформа без домена (D-011): SQL лежит здесь.
import type { LicenseStatus } from '@crm/core/license';
import type { Sql } from '../db';

export type LicenseRow = {
  licenseRaw: string;
  installId: string;
  state: LicenseStatus;
  lastSeenAt: number;
  /** С P10 — момент последнего шага lastSeenAt по часам (правило часов, D-211). */
  checkedAt: number;
  invalidSince: number | null;
  reason: string;
};

/** Строка лицензии под блокировкой (вызывать внутри db.tx). */
export async function lockLicenseRow(sql: Sql): Promise<LicenseRow | undefined> {
  const [row] = await sql<LicenseRow>`
    SELECT license_raw, install_id, state, last_seen_at, checked_at, invalid_since, reason
      FROM license_state WHERE id = 1 FOR UPDATE`;
  return row;
}

export async function readLicenseRow(sql: Sql): Promise<LicenseRow | undefined> {
  const [row] = await sql<LicenseRow>`
    SELECT license_raw, install_id, state, last_seen_at, checked_at, invalid_since, reason
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
    VALUES (1, '', ${installId}, 'missing', ${at}, ${at})
    ON CONFLICT (id) DO NOTHING`;
}

export async function saveLicenseRow(sql: Sql, r: Omit<LicenseRow, 'installId'>): Promise<void> {
  await sql`
    UPDATE license_state
       SET license_raw = ${r.licenseRaw}, state = ${r.state}, last_seen_at = ${r.lastSeenAt},
           checked_at = ${r.checkedAt}, invalid_since = ${r.invalidSince}, reason = ${r.reason}
     WHERE id = 1`;
}
