// Выдача «Предложить контакт» (docs/tasks-team-design.md §5.4, D-258): первым шагом тика карточка созданного
// предложения уходит предложившему (kind 'proposal'), старше 14 дней и отключённому — нет. Разбор РОП: «создать»
// отдаёт карточку предложившему сразу и ставит пару при общем номере, «отклонить» закрывает предложение; повтор
// безопасен, противоположное решение — 409, оператор — 403.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { listProposals, resolveProposal } from '../../../src/server/domain/distribution';
import { runTick } from '../../../src/server/domain/distribution/tick';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { closeCallsWorld, openCallsWorld, viewerOf } from '../calls/world';
import { DAY, SEED_NOW, SPACE, U, makeDeps, seedPool, system, testConfig, tickInput, uuid, type Clock } from './helpers';

let db: TestDb;
const clock: Clock = { now: SEED_NOW };

before(async () => {
  db = await openCallsWorld();
  overrideDistributionDepsForTests(makeDeps(clock));
});
after(async () => {
  overrideDistributionDepsForTests(null);
  await closeCallsWorld(db);
});
beforeEach(async () => {
  await db.sql`DELETE FROM proposals`;
  await db.sql`DELETE FROM assign_log WHERE kind IN ('proposal', 'auto')`;
});

/** Предложение, по которому клиент уже создан: клиент, номер, карточка в пуле, строка proposals. */
async function seedCreated(i: number, userId: string, createdAt = SEED_NOW - 60_000): Promise<{ cardId: string; clientId: string; id: string }> {
  const clientId = `cl-pr-${i}`;
  const cardId = `cd-pr-${i}`;
  const id = uuid();
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
               VALUES (${clientId}, 'company', ${`ТОО Предложена ${i}`}, ${`предложена ${i}`}, ${`предложена ${i}`}, 'proposal', ${createdAt}, ${createdAt})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES (${`pp-pr-${i}`}, ${clientId}, ${`77093${String(i).padStart(6, '0')}`}, 'mobile', TRUE, ${createdAt})`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, state, created_at, updated_at) VALUES (${cardId}, ${SPACE}, ${clientId}, 'new', ${createdAt}, ${createdAt})`;
  await db.sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, client_id, created_at)
               VALUES (${id}, ${SPACE}, ${userId}, ${`77093${String(i).padStart(6, '0')}`}, ${`ТОО Предложена ${i}`}, 'created', ${clientId}, ${createdAt})`;
  return { cardId, clientId, id };
}

const ownerOf = async (cardId: string) => (await db.sql<{ ownerUserId: string | null }>`SELECT owner_user_id FROM cards WHERE id = ${cardId}`)[0]?.ownerUserId ?? null;
const proposalLog = () => db.sql<{ toUserId: string; countsToCap: boolean; runId: string }>`SELECT to_user_id, counts_to_cap, run_id FROM assign_log WHERE kind = 'proposal' ORDER BY card_id`;

test('тик отдаёт карточку предложившему первой; лимит не расходуется, пока capIncludes без proposal', async () => {
  await db.sql`DELETE FROM cards WHERE id LIKE 'pc-%'`;
  await seedPool(db.sql, 5);
  const p = await seedCreated(1, U.opB);
  const runId = uuid();
  const r = await runTick(system(), tickInput(clock, runId), makeDeps(clock));
  assert.equal(r.status, 'done');
  assert.equal(await ownerOf(p.cardId), U.opB);
  assert.deepEqual(await proposalLog(), [{ toUserId: U.opB, countsToCap: false, runId: `${runId}:proposal` }]);
  const note = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE kind = 'cards_assigned' AND user_id = ${U.opB} AND dedupe_key = ${`assign:${runId}:proposal:${U.opB}`}`;
  assert.equal(note[0]?.n, 1);
});

test('capIncludes с proposal: выдача расходует лимит', async () => {
  const p = await seedCreated(2, U.opA);
  const cfg = testConfig({ capIncludes: ['auto', 'proposal'] });
  await runTick(system(), tickInput(clock), makeDeps(clock, cfg));
  assert.equal(await ownerOf(p.cardId), U.opA);
  assert.deepEqual((await proposalLog()).map((l) => l.countsToCap), [true]);
});

test('предложение старше 14 дней и отключённый предложивший: обычная карточка пула, kind proposal не пишется', async () => {
  await seedCreated(3, U.opA, SEED_NOW - 15 * DAY);
  const gone = await seedCreated(4, U.disabled);
  await db.sql`DELETE FROM cards WHERE id LIKE 'pc-%'`;
  const r = await runTick(system(), tickInput(clock), makeDeps(clock, testConfig({ mode: 'auto_even' })));
  assert.ok(['done', 'skipped'].includes(r.status));
  assert.deepEqual(await proposalLog(), []);
  assert.notEqual(await ownerOf(gone.cardId), U.disabled);
});

test('разбор: «создать» — клиент, карточка у предложившего, пара shared_phone с совпавшим; повтор и противоположное решение', async () => {
  const rop = await viewerOf(U.rop);
  const id = uuid();
  await db.sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, matched_client_id, created_at)
               VALUES (${id}, ${SPACE}, ${U.opA}, '77094000001', 'ТОО Совпавшая', 'review', 'cl-b-1', ${SEED_NOW - 1000})`;
  const view = await listProposals(rop);
  const row = view.find((p) => p.id === id);
  assert.deepEqual([row?.phone, row?.name, row?.userName !== '', row?.matchedClientId], ['+77094000001', 'ТОО Совпавшая', true, 'cl-b-1']);

  const opId = uuid();
  const res = await resolveProposal(rop, id, { opId, decision: 'create' });
  assert.deepEqual(res, { status: 'created', replayed: false });
  const [p] = await db.sql<{ status: string; clientId: string; resolvedBy: string }>`SELECT status, client_id, resolved_by FROM proposals WHERE id = ${id}`;
  assert.deepEqual([p?.status, p?.resolvedBy], ['created', U.rop]);
  const [card] = await db.sql<{ ownerUserId: string; state: string }>`SELECT owner_user_id, state FROM cards WHERE client_id = ${p!.clientId}`;
  assert.deepEqual(card, { ownerUserId: U.opA, state: 'new' });
  const log = await db.sql<{ kind: string; runId: string; actorId: string }>`SELECT kind, run_id, actor_id FROM assign_log WHERE to_user_id = ${U.opA} AND kind = 'proposal'`;
  assert.deepEqual(log, [{ kind: 'proposal', runId: opId, actorId: U.rop }]);
  const pairs = await db.sql<{ a: string; b: string; reason: string; status: string }>`
    SELECT a_client_id AS a, b_client_id AS b, reason, status FROM dup_pairs WHERE a_client_id = ${p!.clientId} OR b_client_id = ${p!.clientId}`;
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0]!.a < pairs[0]!.b);
  assert.deepEqual([pairs[0]!.reason, pairs[0]!.status], ['shared_phone', 'open']);
  const audit = await db.sql<{ action: string }>`SELECT action FROM audit_log WHERE action = 'proposal.resolve' AND entity_id = ${id}`;
  assert.equal(audit.length, 1);

  // повтор — прежний итог, второго клиента нет
  assert.deepEqual(await resolveProposal(rop, id, { opId: uuid(), decision: 'create' }), { status: 'created', replayed: true });
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients WHERE name = 'ТОО Совпавшая'`;
  assert.equal(n[0]?.n, 1);
  await assert.rejects(resolveProposal(rop, id, { opId: uuid(), decision: 'reject' }), ConflictError);
});

test('разбор: «отклонить», чужой id — 404, оператор — 403, номер из стоп-листа создать нельзя', async () => {
  const rop = await viewerOf(U.rop);
  const id = uuid();
  await db.sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, created_at) VALUES (${id}, ${SPACE}, ${U.opA}, '77094000002', 'ТОО Отклонённая', 'review', ${SEED_NOW})`;
  assert.deepEqual(await resolveProposal(rop, id, { opId: uuid(), decision: 'reject' }), { status: 'rejected', replayed: false });
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients WHERE name = 'ТОО Отклонённая'`;
  assert.equal(n[0]?.n, 0);
  await assert.rejects(resolveProposal(rop, uuid(), { opId: uuid(), decision: 'reject' }), NotFoundError);

  const op = await viewerOf(U.opA);
  await assert.rejects(resolveProposal(op, id, { opId: uuid(), decision: 'reject' }), ForbiddenError);
  await assert.rejects(listProposals(op), ForbiddenError);

  const stopped = uuid();
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77094000003')}, 'asked', 'manual', ${SEED_NOW}) ON CONFLICT DO NOTHING`;
  await db.sql`INSERT INTO proposals (id, space_id, user_id, digits, name, status, created_at) VALUES (${stopped}, ${SPACE}, ${U.opA}, '77094000003', 'ТОО Из Стоп-листа', 'review', ${SEED_NOW})`;
  await assert.rejects(resolveProposal(rop, stopped, { opId: uuid(), decision: 'create' }), ConflictError);
});
