// Пароль стенда из окружения: один на всех, в отчёт не попадает; малый набор клиентов.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PASSWORD_ENV, runSeed } from '../../../scripts/seed';
import { verifyPassword } from '../../../src/server/platform/auth/password';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';

let db: TestDb;
let assets: string;
const PASSWORD = 'Stand-Demo-2026';

before(async () => {
  db = await createTestDb();
  assets = await mkdtemp(path.join(os.tmpdir(), 'crm-seed-assets-'));
});
after(async () => {
  await db.close();
  await rm(assets, { recursive: true, force: true });
});

test('пароль из окружения: учётки входят с ним, отчёт его не содержит; малый набор', async () => {
  const env = { ...process.env, NODE_ENV: 'test', CRM_ASSETS_DIR: assets, [PASSWORD_ENV]: PASSWORD };
  const r = await runSeed({ env, now: Date.parse('2026-10-20T04:00:00Z'), clients: 40, operators: 3 });
  assert.equal(r.accounts.length, 10);
  assert.ok(r.accounts.every((a) => a.password === null));
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients`)[0]?.n, 40);
  const users = await db.sql<{ passwordHash: string }>`SELECT password_hash FROM users`;
  assert.equal(users.length, 10);
  for (const u of users) assert.equal(await verifyPassword(PASSWORD, u.passwordHash), true);
  const again = await runSeed({ env, now: Date.parse('2026-10-20T04:00:00Z'), clients: 40, operators: 3 });
  assert.equal(again.changes, 0);
});
