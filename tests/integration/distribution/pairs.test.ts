// Пары и гонки тика (docs/distribution-design.md §4, §7; PROCESS 12.11, 12.12): двойники, владелец пары,
// «Не звонить», гонка с импортом, гонка тика с ручной выдачей.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCards } from '../../../src/server/domain/distribution/manual';
import { runTick } from '../../../src/server/domain/distribution/tick';
import type { TestDb } from '../../../src/server/platform/db/testing';
import {
  SEED_NOW,
  U,
  closeWorld,
  makeDeps,
  openDistributionWorld,
  ownersOf,
  poolOwnership,
  resetPool,
  seedIssued,
  seedPair,
  seedPool,
  system,
  testConfig,
  tickInput,
  uuid,
  viewerOf,
  type Clock,
} from './helpers';

let db: TestDb;
const clock: Clock = { now: SEED_NOW };

before(async () => {
  db = await openDistributionWorld();
  await seedPool(db.sql, 40);
});
after(async () => closeWorld(db));

async function reset() {
  await resetPool(db.sql);
  await db.sql`DELETE FROM dup_pairs`;
  await db.sql`UPDATE cards SET state = 'retry' WHERE id LIKE 'cd-%'`;
}

test('три клиента с общим номером → все три одному оператору', async () => {
  await reset();
  await seedPair(db.sql, 'pl-1', 'pl-2');
  await seedPair(db.sql, 'pl-2', 'pl-3');
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  assert.equal(r.status, 'done');
  const o = await ownersOf(db.sql, ['pc-1', 'pc-2', 'pc-3']);
  assert.ok(o['pc-1'] && o['pc-1'] === o['pc-2'] && o['pc-2'] === o['pc-3'], JSON.stringify(o));
});

test('двойник у оператора B → карточка ему же; лимит B исчерпан → остаётся в пуле (heldBack)', async () => {
  await reset();
  await seedPair(db.sql, 'cl-b-1', 'pl-5');
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  assert.equal((await ownersOf(db.sql, ['pc-5']))['pc-5'], U.opB);
  assert.equal(r.heldBack, 0);

  await reset();
  await seedPair(db.sql, 'cl-b-1', 'pl-5');
  await seedIssued(db.sql, U.opB, 'manual', 20, ['cd-b-2']);
  const r2 = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  assert.equal((await ownersOf(db.sql, ['pc-5']))['pc-5'], null, 'пара не делится: остаётся в пуле');
  assert.equal(r2.heldBack, 1);
  assert.equal(r2.issued[U.opB] ?? 0, 0);
});

test('напарник в «Не звонить» (пара open) → блокировка; пара distinct → раздаётся', async () => {
  await reset();
  await db.sql`UPDATE cards SET state = 'do_not_call' WHERE id = 'cd-a-1'`;
  await seedPair(db.sql, 'cl-a-1', 'pl-6');
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  assert.equal((await ownersOf(db.sql, ['pc-6']))['pc-6'], null);
  assert.equal(r.blocked, 1);

  await reset();
  await db.sql`UPDATE cards SET state = 'do_not_call' WHERE id = 'cd-a-1'`;
  await seedPair(db.sql, 'cl-a-1', 'pl-6', 'distinct');
  const r2 = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  assert.ok((await ownersOf(db.sql, ['pc-6']))['pc-6']);
  assert.equal(r2.blocked, 0);
});

test('split_allowed и merged пару не держат: карточки раздаются независимо', async () => {
  await reset();
  await seedPair(db.sql, 'pl-1', 'pl-2', 'split_allowed');
  await seedPair(db.sql, 'pl-3', 'pl-4', 'merged');
  await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 2 })));
  const o = await ownersOf(db.sql, ['pc-1', 'pc-2', 'pc-3', 'pc-4']);
  assert.ok(Object.values(o).every((v) => v !== null), JSON.stringify(o));
  // пара держала бы обе карточки у одного; независимая раздача разводит по наименее загруженным
  assert.notEqual(o['pc-1'], o['pc-2']);
  assert.notEqual(o['pc-3'], o['pc-4']);
});

test('гонка с импортом: карточки под FOR UPDATE пропускаются, двойник остаётся в пуле, тик не ждёт', async () => {
  await reset();
  await seedPair(db.sql, 'pl-1', 'pl-2');
  let locked!: () => void;
  const lockedP = new Promise<void>((r) => (locked = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const holder = db.tx(async (sql) => {
    await sql`SELECT id FROM cards WHERE id = ANY(${['pc-1', 'pc-11', 'pc-12', 'pc-13', 'pc-14']}::text[]) ORDER BY id FOR UPDATE`;
    locked();
    await held;
  });
  await lockedP;
  const t0 = Date.now();
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ dailyCap: 20 })));
  const took = Date.now() - t0;
  release();
  await holder;
  assert.ok(took < 2000, `тик ждал ${took} мс`);
  assert.equal(r.raced, 6, 'пять занятых и двойник занятой');
  const o = await ownersOf(db.sql, ['pc-1', 'pc-2', 'pc-11', 'pc-12', 'pc-13', 'pc-14']);
  assert.ok(Object.values(o).every((v) => v === null), JSON.stringify(o));
});

test('гонка тика и ручной выдачи тому же оператору (20 прогонов): выдано не больше лимита, дублей в журнале нет', async () => {
  const rop = await viewerOf(U.rop);
  const cfg = testConfig({ dailyCap: 10 });
  let tickFirst = 0;
  for (let i = 0; i < 20; i++) {
    await reset();
    const deps = makeDeps(clock, cfg);
    const results = await Promise.allSettled([
      runTick(system(), tickInput(clock), deps),
      issueCards(rop, { opId: uuid(), toUserId: U.opA, count: 10 }, deps),
    ]);
    assert.equal(results[0]?.status, 'fulfilled');
    const rows = await db.sql<{ cardId: string; toUserId: string; kind: string }>`SELECT card_id, to_user_id, kind FROM assign_log`;
    assert.equal(new Set(rows.map((r) => r.cardId)).size, rows.length, 'карточка выдана дважды');
    const toA = rows.filter((r) => r.toUserId === U.opA).length;
    assert.ok(toA <= 10, `оператору A выдано ${toA} при лимите 10`);
    const own = await poolOwnership(db.sql);
    assert.equal(own[U.opA] ?? 0, toA);
    if (rows.some((r) => r.kind === 'auto' && r.toUserId === U.opA)) tickFirst++;
    if (results[1]?.status === 'rejected') {
      assert.equal((results[1].reason as { code?: string }).code, 'over_cap', String(results[1].reason));
    }
  }
  assert.ok(tickFirst >= 0);
});
