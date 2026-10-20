// Ручная выдача РОП (docs/distribution-design.md §3.2, §7): лимит, повтор opId, пары, статусы, права.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { DistributionDomainError } from '../../../src/server/domain/distribution/errors';
import { issueCards } from '../../../src/server/domain/distribution/manual';
import type { DistributionDeps, ManualIssueInput } from '../../../src/server/domain/distribution/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import {
  SEED_NOW,
  SEED_TODAY,
  SPACE,
  U,
  closeWorld,
  logCount,
  makeDeps,
  openDistributionWorld,
  ownersOf,
  resetPool,
  seedIssued,
  seedPair,
  seedPool,
  testConfig,
  uuid,
  viewerOf,
  type Clock,
} from './helpers';

let db: TestDb;
let rop: Viewer;
const clock: Clock = { now: SEED_NOW };
const deps = (over = {}): DistributionDeps => makeDeps(clock, testConfig(over));

before(async () => {
  db = await openDistributionWorld();
  await seedPool(db.sql, 30);
  rop = await viewerOf(U.rop);
});
after(async () => closeWorld(db));

async function reset() {
  await resetPool(db.sql);
  await db.sql`DELETE FROM dup_pairs`;
  await db.sql`DELETE FROM audit_log WHERE action = 'distribution.issue'`;
  await db.sql`UPDATE memberships SET paused_on = '' WHERE role_key = 'operator'`;
  await db.sql`DELETE FROM absences`;
  await db.sql`UPDATE cards SET state = 'retry' WHERE id LIKE 'cd-%'`;
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as DistributionDomainError,
  );

test('первые N из пула: журнал manual, РОП в actor_id, лимит учтён, аудит записан', async () => {
  await reset();
  const r = await issueCards(rop, { opId: uuid(), toUserId: U.opA, count: 5 }, deps());
  assert.equal(r.issued.length, 5);
  assert.deepEqual(r.issued, ['pc-1', 'pc-2', 'pc-3', 'pc-4', 'pc-5']);
  assert.equal(r.remaining, 35);
  assert.equal(r.cap, 40);
  assert.equal(r.replayed, false);
  const log = await db.sql<{ kind: string; actorId: string; countsToCap: boolean; day: string }>`SELECT kind, actor_id, counts_to_cap, day FROM assign_log`;
  assert.equal(log.length, 5);
  assert.ok(log.every((l) => l.kind === 'manual' && l.actorId === U.rop && l.countsToCap && l.day === SEED_TODAY));
  const audit = await db.sql<{ entityId: string; meta: { count: number } }>`SELECT entity_id, meta FROM audit_log WHERE action = 'distribution.issue'`;
  assert.deepEqual(audit.map((a) => [a.entityId, a.meta.count]), [[U.opA, 5]]);
  const ev = await db.sql<{ actorId: string }>`SELECT actor_id FROM client_events WHERE kind = 'card.assigned'`;
  assert.equal(ev.length, 5);
  assert.ok(ev.every((e) => e.actorId === U.rop));
});

test('повтор того же opId → прежний итог, replayed, новых строк нет', async () => {
  await reset();
  const input: ManualIssueInput = { opId: uuid(), toUserId: U.opB, count: 3 };
  const first = await issueCards(rop, input, deps());
  const before = await logCount(db.sql);
  const again = await issueCards(rop, input, deps());
  assert.equal(again.replayed, true);
  assert.deepEqual([...again.issued].sort(), [...first.issued].sort());
  assert.equal(await logCount(db.sql), before);
});

test('сверх остатка → over_cap с «осталось N из M», ничего не выдано', async () => {
  await reset();
  await seedIssued(db.sql, U.opA, 'auto', 35, ['cd-a-1']);
  const e = await failure(issueCards(rop, { opId: uuid(), toUserId: U.opA, count: 10 }, deps()));
  assert.ok(e instanceof DistributionDomainError);
  assert.deepEqual([e.code, e.remaining, e.cap, e.status], ['over_cap', 5, 40, 409]);
  assert.equal(await logCount(db.sql, 'manual'), 0);
  assert.ok(Object.values(await ownersOf(db.sql, ['pc-1', 'pc-2'])).every((v) => v === null));
});

test('capOverride разрешает сверх остатка; если manual не входит в состав лимита — лимит не ограничивает', async () => {
  await reset();
  await seedIssued(db.sql, U.opA, 'auto', 38, ['cd-a-1']);
  const a = await issueCards(rop, { opId: uuid(), toUserId: U.opA, count: 6 }, deps({ capOverride: true }));
  assert.equal(a.issued.length, 6);
  assert.equal(a.remaining, 0);
  await reset();
  await seedIssued(db.sql, U.opA, 'auto', 40, ['cd-a-1']);
  const b = await issueCards(rop, { opId: uuid(), toUserId: U.opA, count: 4 }, deps({ capIncludes: ['auto'] }));
  assert.equal(b.issued.length, 4);
  assert.equal(await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM assign_log WHERE kind = 'manual' AND counts_to_cap`.then((r) => r[0]?.n), 0);
});

test('выбранная карточка с двойником в пуле → выданы обе', async () => {
  await reset();
  await seedPair(db.sql, 'pl-2', 'pl-3');
  const r = await issueCards(rop, { opId: uuid(), toUserId: U.opA, cardIds: ['pc-2'] }, deps());
  assert.deepEqual([...r.issued].sort(), ['pc-2', 'pc-3']);
  const o = await ownersOf(db.sql, ['pc-2', 'pc-3']);
  assert.deepEqual(Object.values(o), [U.opA, U.opA]);
});

test('двойник у другого сотрудника → pair_held; ему самому выдать можно; «Не звонить» → pair_blocked', async () => {
  await reset();
  await seedPair(db.sql, 'cl-b-1', 'pl-5');
  const held = await issueCards(rop, { opId: uuid(), toUserId: U.opA, cardIds: ['pc-5', 'pc-6'] }, deps());
  assert.deepEqual(held.skipped, [{ cardId: 'pc-5', reason: 'pair_held' }]);
  assert.deepEqual(held.issued, ['pc-6']);
  const own = await issueCards(rop, { opId: uuid(), toUserId: U.opB, cardIds: ['pc-5'] }, deps());
  assert.deepEqual(own.issued, ['pc-5']);

  await db.sql`UPDATE cards SET state = 'do_not_call' WHERE id = 'cd-a-1'`;
  await seedPair(db.sql, 'cl-a-1', 'pl-7');
  const blocked = await issueCards(rop, { opId: uuid(), toUserId: U.opA, cardIds: ['pc-7'] }, deps());
  assert.deepEqual(blocked.skipped, [{ cardId: 'pc-7', reason: 'pair_blocked' }]);
  assert.deepEqual(blocked.issued, []);
});

test('карточка не в пуле или несуществующая → not_in_pool', async () => {
  await reset();
  const r = await issueCards(rop, { opId: uuid(), toUserId: U.opA, cardIds: ['cd-b-1', 'zz-none', 'pc-9'] }, deps());
  assert.deepEqual(r.issued, ['pc-9']);
  assert.deepEqual(r.skipped.map((s) => [s.cardId, s.reason]).sort(), [['cd-b-1', 'not_in_pool'], ['zz-none', 'not_in_pool']]);
});

test('на паузе или отсутствует → not_working; не участник → not_participant; режим off → mode_off', async () => {
  await reset();
  await db.sql`UPDATE memberships SET paused_on = ${SEED_TODAY} WHERE user_id = ${U.opA}`;
  await db.sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, created_at) VALUES ('ab-m', ${SPACE}, ${U.opB}, ${SEED_TODAY}, ${SEED_TODAY}, ${SEED_NOW})`;
  for (const to of [U.opA, U.opB]) {
    const e = await failure(issueCards(rop, { opId: uuid(), toUserId: to, count: 1 }, deps()));
    assert.equal(e?.code, 'not_working', to);
  }
  const np = await failure(issueCards(rop, { opId: uuid(), toUserId: U.director, count: 1 }, deps()));
  assert.equal(np?.code, 'not_participant');
  assert.equal(np?.status, 400);
  const off = await failure(issueCards(rop, { opId: uuid(), toUserId: U.duty, count: 1 }, deps({ mode: 'off' })));
  assert.equal(off?.code, 'mode_off');
  assert.equal(await logCount(db.sql), 0);
  await reset();
});

test('участнику без флага in_distribution выдать вручную можно (флаг нужен только тику)', async () => {
  await reset();
  await db.sql`UPDATE memberships SET in_distribution = FALSE WHERE user_id = ${U.duty}`;
  const r = await issueCards(rop, { opId: uuid(), toUserId: U.duty, count: 2 }, deps());
  assert.equal(r.issued.length, 2);
  await db.sql`UPDATE memberships SET in_distribution = TRUE WHERE user_id = ${U.duty}`;
});

test('оператор без card.assign → 403', async () => {
  const op = await viewerOf(U.opA);
  const e = await failure(issueCards(op, { opId: uuid(), toUserId: U.opA, count: 1 }, deps()));
  assert.ok(e instanceof ForbiddenError, String(e));
});
