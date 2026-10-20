/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД в тестах читаются по путям */
// crmctl ingest-key: create / list / revoke на Postgres; ключ печатается один раз, в БД только хэш.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runIngestKey, type IngestCtx } from '../../../scripts/crmctl/ingest';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { getDemand, installIntakeConfig, post, ph, batch, T0 } from './helpers';

let db: TestDb;

before(async () => {
  db = await createTestDb();
  await installIntakeConfig();
});
after(async () => {
  await db.close();
});

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: IngestCtx = { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, openDb: async () => async () => {}, now: () => T0 };
  return runIngestKey(argv, ctx).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

test('create → ключ напечатан один раз и работает; list не показывает секрет; revoke отзывает', async () => {
  const created = await run(['create', '--space', 'sales', '--source', 'open', '--scopes', 'leads:write,leads:demand', '--managed', 'cli']);
  assert.equal(created.code, 0, created.err);
  const key = /crm1_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/.exec(created.out)?.[0];
  assert.ok(key, 'ключ в выводе');
  const prefix = key.slice(5, 13);
  const [row] = await db.sql<any>`SELECT * FROM ingest_keys WHERE prefix = ${prefix}`;
  assert.equal(row.managed, 'cli');
  assert.equal(row.sourceKey, 'open');
  assert.deepEqual(row.scopes, ['leads:write', 'leads:demand']);
  assert.ok(!JSON.stringify(row).includes(key.slice(14)), 'секрет в БД не хранится');

  assert.equal((await post(key, batch([{ name: 'ТОО Консоль', phones: [ph(1)] }]))).status, 200);
  assert.equal((await getDemand(key)).status, 200);

  const listed = await run(['list']);
  assert.equal(listed.code, 0);
  assert.match(listed.out, new RegExp(`${prefix}\\topen\\tsales\\tleads:write,leads:demand\\tmanaged=cli`));
  assert.ok(!listed.out.includes(key.slice(14)));

  const revoked = await run(['revoke', prefix]);
  assert.equal(revoked.code, 0, revoked.err);
  assert.equal((await post(key, batch([{ name: 'ТОО После отзыва', phones: [ph(2)] }]))).status, 401);
  assert.match((await run(['list'])).out, /отозван/);
  const again = await run(['revoke', prefix]);
  assert.equal(again.code, 1);
});

test('create: ошибки аргументов и настроек не создают ключ', async () => {
  const before = (await db.sql<any>`SELECT count(*)::int AS n FROM ingest_keys`)[0].n;
  for (const argv of [
    ['create', '--source', 'open'],
    ['create', '--space', 'sales', '--source', 'open', '--scopes', 'leads:read'],
    ['create', '--space', 'sales', '--source', 'open', '--managed', 'web'],
    ['create', '--space', 'нет', '--source', 'open'],
    ['create', '--space', 'sales', '--source', 'нет'],
    ['create', '--space', 'sales', '--source', 'manual'],
    ['create', '--space', 'sales', '--source', 'open', '--лишний', 'x'],
    ['revoke'],
    ['revoke', 'КОРОТКО'],
    ['неизвестно'],
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.ok(r.err.length > 0);
  }
  assert.equal((await db.sql<any>`SELECT count(*)::int AS n FROM ingest_keys`)[0].n, before);
});
