// Ключи приёма: создание и отзыв пишут аудит без значения ключа и хэша.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { systemActor } from '../../../src/server/access/systemActor';
import { revokeKey } from '../../../src/server/domain/intake';
import { installIntakeConfig, mkKey, T0 } from '../intake/helpers';

let db: TestDb;
before(async () => {
  db = await createTestDb();
  await installIntakeConfig();
});
after(async () => {
  await db.close();
});

test('create/revoke ключа приёма попадают в audit_log без секрета', async () => {
  const k = await mkKey('open');
  assert.equal(await revokeKey(systemActor('test', T0), k.prefix), true);
  assert.equal(await revokeKey(systemActor('test', T0), k.prefix), false); // повторный отзыв не пишет аудит
  const rows = await db.sql<{ action: string; entity: string; meta: Record<string, unknown> }>`
    SELECT action, entity, meta FROM audit_log WHERE action LIKE 'ingest_key.%' AND meta->>'prefix' = ${k.prefix} ORDER BY created_at, action`;
  assert.deepEqual(rows.map((r) => r.action).sort(), ['ingest_key.create', 'ingest_key.revoke']);
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes(k.key), 'значение ключа не должно быть в журнале');
  assert.ok(!dump.includes(k.key.split('_')[2] as string), 'секрет не должен быть в журнале');
});
