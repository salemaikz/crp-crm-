// SQL секретов интеграций (integration_secrets). Платформа без домена (D-011), поэтому SQL здесь, как config/repo.ts.
// Открытое значение живёт только в памяти вызова: в логи, ошибки и ответы не попадает.
import type { Sql } from '../db';
import { jsonParam } from '../db/core';
import { openSecret, sealSecret } from './aesgcm';
import { SecretError, isSecretError, loadKeyring } from './keys';
import type {
  DeleteIntegrationSecrets,
  DescribeIntegrationSecrets,
  GetIntegrationSecret,
  PutIntegrationSecret,
  RotateSecrets,
  SealedSecret,
  SecretKeyring,
} from './types';

type SecretRow = { integrationId: string; name: string; kid: string; iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };

/** «задан, …abcd»: последние 4 символа только у достаточно длинных значений, иначе пусто. */
export function last4Of(plaintext: string): string {
  return plaintext.length >= 12 ? plaintext.slice(-4) : '';
}

const sealedOf = (r: SecretRow): SealedSecret => ({ kid: r.kid, iv: new Uint8Array(r.iv), ciphertext: new Uint8Array(r.ciphertext), tag: new Uint8Array(r.tag) });
const buf = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

export const putIntegrationSecret: PutIntegrationSecret = async (sql, { integrationId, name, plaintext, now }) => {
  const s = sealSecret(loadKeyring(), { integrationId, name, plaintext });
  await sql`
    INSERT INTO integration_secrets (integration_id, name, kid, iv, ciphertext, tag, last4, updated_at)
    VALUES (${integrationId}, ${name}, ${s.kid}, ${buf(s.iv)}, ${buf(s.ciphertext)}, ${buf(s.tag)}, ${last4Of(plaintext)}, ${now})
    ON CONFLICT (integration_id, name) DO UPDATE
      SET kid = EXCLUDED.kid, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext, tag = EXCLUDED.tag,
          last4 = EXCLUDED.last4, updated_at = EXCLUDED.updated_at`;
};

export const getIntegrationSecret: GetIntegrationSecret = async (sql, { integrationId, name }) => {
  const [row] = await sql<SecretRow>`
    SELECT integration_id, name, kid, iv, ciphertext, tag FROM integration_secrets
     WHERE integration_id = ${integrationId} AND name = ${name}`;
  if (!row) throw new SecretError('not_found');
  return openSecret(loadKeyring(), { integrationId, name, sealed: sealedOf(row) });
};

export const deleteIntegrationSecrets: DeleteIntegrationSecrets = async (sql, integrationId) => {
  const rows = await sql<{ name: string }>`DELETE FROM integration_secrets WHERE integration_id = ${integrationId} RETURNING name`;
  return rows.length;
};

export const describeIntegrationSecrets: DescribeIntegrationSecrets = async (sql, integrationId) =>
  sql<{ name: string; last4: string; updatedAt: number }>`
    SELECT name, last4, updated_at FROM integration_secrets WHERE integration_id = ${integrationId} ORDER BY name`;

const ROTATE_BATCH = 100;

/**
 * Перешифровать строки с kid ≠ текущего пачками по 100. Каждая пачка — один UPDATE (атомарно) с условием
 * «kid не сменился с момента чтения»: параллельная запись секрета не затирается старым значением.
 * Строка, которая не открылась (нет ключа её kid, подмена), остаётся как есть и считается в failed.
 */
export const rotateSecrets: RotateSecrets = async (sql, ring) => {
  let rotated = 0;
  let failed = 0;
  let after = { integrationId: '', name: '' };
  for (;;) {
    const rows = await sql<SecretRow>`
      SELECT integration_id, name, kid, iv, ciphertext, tag FROM integration_secrets
       WHERE kid <> ${ring.currentKid} AND (integration_id, name) > (${after.integrationId}, ${after.name})
       ORDER BY integration_id, name LIMIT ${ROTATE_BATCH}`;
    if (rows.length === 0) break;
    const last = rows[rows.length - 1] as SecretRow;
    after = { integrationId: last.integrationId, name: last.name };
    const updates: { integration_id: string; name: string; old_kid: string; kid: string; iv: string; ciphertext: string; tag: string }[] = [];
    for (const r of rows) {
      try {
        const plaintext = openSecret(ring, { integrationId: r.integrationId, name: r.name, sealed: sealedOf(r) });
        const s = sealSecret(ring, { integrationId: r.integrationId, name: r.name, plaintext });
        updates.push({ integration_id: r.integrationId, name: r.name, old_kid: r.kid, kid: s.kid, iv: buf(s.iv).toString('hex'), ciphertext: buf(s.ciphertext).toString('hex'), tag: buf(s.tag).toString('hex') });
      } catch (e) {
        if (!isSecretError(e)) throw e;
        failed++;
      }
    }
    if (updates.length === 0) continue;
    const done = await sql<{ name: string }>`
      UPDATE integration_secrets s
         SET kid = u.kid, iv = decode(u.iv, 'hex'), ciphertext = decode(u.ciphertext, 'hex'), tag = decode(u.tag, 'hex')
        FROM jsonb_to_recordset(${jsonParam(updates)})
             AS u(integration_id text, name text, old_kid text, kid text, iv text, ciphertext text, tag text)
       WHERE s.integration_id = u.integration_id AND s.name = u.name AND s.kid = u.old_kid
      RETURNING s.name`;
    rotated += done.length;
  }
  return { rotated, failed };
};

/** `crmctl secrets rotate --check`: открывается ли каждая строка текущим набором ключей; сколько ещё на старом kid. */
export async function checkSecrets(sql: Sql, ring: SecretKeyring): Promise<{ total: number; ok: number; failed: number; stale: number }> {
  let ok = 0;
  let failed = 0;
  let stale = 0;
  let total = 0;
  let after = { integrationId: '', name: '' };
  for (;;) {
    const rows = await sql<SecretRow>`
      SELECT integration_id, name, kid, iv, ciphertext, tag FROM integration_secrets
       WHERE (integration_id, name) > (${after.integrationId}, ${after.name})
       ORDER BY integration_id, name LIMIT ${ROTATE_BATCH}`;
    if (rows.length === 0) break;
    const last = rows[rows.length - 1] as SecretRow;
    after = { integrationId: last.integrationId, name: last.name };
    for (const r of rows) {
      total++;
      if (r.kid !== ring.currentKid) stale++;
      try {
        openSecret(ring, { integrationId: r.integrationId, name: r.name, sealed: sealedOf(r) });
        ok++;
      } catch (e) {
        if (!isSecretError(e)) throw e;
        failed++;
      }
    }
  }
  return { total, ok, failed, stale };
}
