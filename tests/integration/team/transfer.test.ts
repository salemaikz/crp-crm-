// B9a (docs/tasks-team-design.md §6, §10): передача клиента одним действием и массовая. Мир изоляции + настройки
// обзвона; номера и имена — синтетика (+7 709 …). Дата «сейчас» мира — среда 28.10.2026 11:00 (Алматы).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { loadClientPage } from '../../../src/server/domain/clients';
import { previewBulk, transferBulk, transferOne } from '../../../src/server/domain/team';
import { TeamError } from '../../../src/server/domain/team/errors';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U } from '../../isolation/harness/seed';
import { applyCardEventLocked, loadCallingContext } from '../../../src/server/domain/cards';
import { lockCardUnscoped } from '../../../src/server/domain/cards/repo';
import { closeCallsWorld, openCallsWorld, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let rop: Viewer;
let opA: Viewer;
let opB: Viewer;
const uuid = (): string => globalThis.crypto.randomUUID();
const local = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00+05:00`);
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error);

const card = async (id: string) =>
  (await db.sql<{ owner: string | null; acting: string | null; until: string; state: string; version: number }>`
    SELECT owner_user_id AS owner, acting_user_id AS acting, acting_until_day AS until, state, version FROM cards WHERE id = ${id}`)[0]!;

async function reset(): Promise<void> {
  await db.sql`DELETE FROM change_snapshots`;
  await db.sql`DELETE FROM assign_log`;
  await db.sql`DELETE FROM notifications`;
  await db.sql`DELETE FROM audit_log WHERE action = 'client.transfer'`;
  await db.sql`DELETE FROM dup_pairs`;
  await db.sql`DELETE FROM bookings WHERE id LIKE 'bk-tr-%'`;
  await db.sql`DELETE FROM tasks WHERE id LIKE 'tk-tr-%'`;
  await db.sql`DELETE FROM deals WHERE id LIKE 'dl-tr-%'`;
  await db.sql`DELETE FROM client_events WHERE kind = 'card.transferred'`;
  await db.sql`UPDATE cards SET owner_user_id = CASE WHEN client_id LIKE 'cl-a-%' THEN ${U.opA} ELSE ${U.opB} END, acting_user_id = NULL, acting_until_day = '',
                              state = 'retry', calls_total = 0, version = 0 WHERE id LIKE 'cd-a-%' OR id LIKE 'cd-b-%'`;
  await db.sql`UPDATE tasks SET assignee_user_id = ${U.opA} WHERE id = 'tk-a-1'`;
  await db.sql`UPDATE deals SET owner_user_id = ${U.opA}, version = 0 WHERE id = 'dl-a-1'`;
}

before(async () => {
  process.env.FEATURE_BULK_TRANSFER = '1';
  db = await openCallsWorld();
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
});
after(async () => {
  delete process.env.FEATURE_BULK_TRANSFER;
  await closeCallsWorld(db);
});

test('A → B: открытые сделки и задачи клиента у B, выигранная у A, задача РОП без исполнителя не тронута, будущая запись — ответственный B', async () => {
  await reset();
  const t = SEED_NOW;
  // выигранная сделка клиента A1, задача РОП без исполнителя, будущая запись (автор A) и прошедшая
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, won_at, created_by, created_at, updated_at)
               VALUES ('dl-tr-won', ${SPACE}, 'sales', 'paid', 'won', 'cl-a-1', 'cd-a-1', ${U.opA}, ${t}, ${t}, ${U.opA}, ${t}, ${t})`;
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-tr-rop', ${SPACE}, 'cl-a-1', 'other', 'manual', 'Задача РОП', NULL, ${t}),
                      ('tk-tr-other', ${SPACE}, 'cl-a-1', 'other', 'manual', 'Чужая задача', ${U.rop}, ${t})`;
  for (const [id, day] of [['bk-tr-future', '2026-10-30'], ['bk-tr-past', '2026-10-27']] as const) {
    await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time, starts_at, duration_min,
                                       booked_by_user_id, responsible_user_id, created_at, updated_at)
                 VALUES (${id}, ${SPACE}, 'individual', 'consult', 'rs-cons', 'cl-a-1', 'cd-a-1', ${day}, '11:00', ${local(day, '11:00')}, 60, ${U.opA}, ${U.opA}, ${t}, ${t})`;
  }
  const opId = uuid();
  const r = await transferOne(rop, { opId, cardId: 'cd-a-1', version: 0, toUserId: U.opB });
  assert.deepEqual([r.moved, r.related, r.replayed], [1, 0, false]);

  const c = await card('cd-a-1');
  assert.deepEqual([c.owner, c.acting, c.version], [U.opB, null, 1]);
  const deals = await db.sql<{ id: string; owner: string }>`SELECT id, owner_user_id AS owner FROM deals WHERE client_id = 'cl-a-1' ORDER BY id`;
  assert.deepEqual(deals.map((d) => [d.id, d.owner]), [['dl-a-1', U.opB], ['dl-tr-won', U.opA]]);
  const tasks = await db.sql<{ id: string; assignee: string | null }>`SELECT id, assignee_user_id AS assignee FROM tasks WHERE client_id = 'cl-a-1' ORDER BY id`;
  assert.deepEqual(tasks.map((x) => [x.id, x.assignee]), [['tk-a-1', U.opB], ['tk-tr-other', U.rop], ['tk-tr-rop', null]]);
  const bookings = await db.sql<{ id: string; responsible: string; booked: string }>`SELECT id, responsible_user_id AS responsible, booked_by_user_id AS booked FROM bookings WHERE client_id = 'cl-a-1' ORDER BY id`;
  assert.deepEqual(bookings.map((b) => [b.id, b.responsible, b.booked]), [['bk-tr-future', U.opB, U.opA], ['bk-tr-past', U.opA, U.opA]]);

  const log = await db.sql<{ fromUserId: string; toUserId: string; kind: string; countsToCap: boolean; runId: string; actorId: string }>`
    SELECT from_user_id, to_user_id, kind, counts_to_cap, run_id, actor_id FROM assign_log WHERE card_id = 'cd-a-1'`;
  assert.deepEqual(log, [{ fromUserId: U.opA, toUserId: U.opB, kind: 'transfer', countsToCap: false, runId: opId, actorId: U.rop }]);
  const feed = await db.sql<{ data: unknown }>`SELECT data FROM client_events WHERE client_id = 'cl-a-1' AND kind = 'card.transferred'`;
  assert.deepEqual(feed.map((f) => f.data), [{ fromUserId: U.opA, toUserId: U.opB }]);
  const note = await db.sql<{ userId: string; params: unknown; dedupeKey: string }>`SELECT user_id, params, dedupe_key FROM notifications WHERE kind = 'client_transferred'`;
  assert.deepEqual(note, [{ userId: U.opB, params: { count: 1 }, dedupeKey: `transfer:${opId}:${U.opB}` }]);
  // в уведомлении нет названия клиента и номеров
  assert.doesNotMatch(JSON.stringify(await db.sql`SELECT * FROM notifications`), /Синтетика|7709/);
  assert.equal((await db.sql`SELECT 1 FROM change_snapshots`).length, 0, 'одиночная передача без снимка (D-062)');
  const audit = await db.sql<{ entity: string; entityId: string; meta: unknown }>`SELECT entity, entity_id, meta FROM audit_log WHERE action = 'client.transfer'`;
  assert.deepEqual(audit, [{ entity: 'client', entityId: 'cl-a-1', meta: { count: 1, recipients: 1, mode: 'one' } }]);

  // прежний владелец сразу теряет клиента (чужое = несуществующее), получатель видит
  assert.equal((await loadClientPage(opA, 'cl-a-1')).kind, 'missing');
  assert.equal((await loadClientPage(opB, 'cl-a-1')).kind, 'ok');

  // повтор того же opId: прежний итог, ничего не двоится
  const again = await transferOne(rop, { opId, cardId: 'cd-a-1', version: 0, toUserId: U.opB });
  assert.deepEqual([again.moved, again.replayed], [1, true]);
  assert.equal((await card('cd-a-1')).version, 1);
  assert.equal((await db.sql`SELECT 1 FROM assign_log WHERE card_id = 'cd-a-1'`).length, 1);
});

test('пакет даёт те же строки, что ядро через общий путь ручных событий', async () => {
  await reset();
  await setCard(db.sql, 'cd-a-40', { state: 'callback', acting: U.duty });
  await setCard(db.sql, 'cd-a-41', { state: 'callback', acting: U.duty });
  await transferOne(rop, { opId: 'op-parity-batch', cardId: 'cd-a-40', version: 0, toUserId: U.opB });
  const ctx = await loadCallingContext(SPACE, SEED_NOW);
  await db.tx(async (tx) => {
    const row = (await lockCardUnscoped(tx, 'cd-a-41'))!;
    const r = await applyCardEventLocked(tx, rop, row, ctx, { type: 'transfer', opId: 'op-parity-core', toUserId: U.opB, seenVersion: 0, facts: { toUserActive: true } }, SEED_NOW, { opId: 'op-parity-core' });
    assert.equal(r.status, 'applied');
  });
  const shape = async (id: string, client: string, op: string) => ({
    card: await card(id).then((c) => ({ ...c })),
    log: await db.sql`SELECT from_user_id, to_user_id, kind, counts_to_cap, actor_id FROM assign_log WHERE card_id = ${id} AND run_id = ${op}`,
    feed: await db.sql`SELECT kind, actor_id, data FROM client_events WHERE client_id = ${client} AND kind = 'card.transferred'`,
  });
  assert.deepEqual(await shape('cd-a-40', 'cl-a-40', 'op-parity-batch'), await shape('cd-a-41', 'cl-a-41', 'op-parity-core'));
});

test('временный владелец снимается, его задачи идут получателю', async () => {
  await reset();
  await setCard(db.sql, 'cd-a-2', { acting: U.duty });
  await db.sql`UPDATE cards SET acting_until_day = '2026-10-30' WHERE id = 'cd-a-2'`;
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-tr-act', ${SPACE}, 'cl-a-2', 'call', 'callback', 'У временного', ${U.duty}, ${SEED_NOW}),
                      ('tk-tr-own', ${SPACE}, 'cl-a-2', 'call', 'callback', 'У владельца', ${U.opA}, ${SEED_NOW})`;
  await transferOne(rop, { opId: uuid(), cardId: 'cd-a-2', version: 0, toUserId: U.opB });
  const c = await card('cd-a-2');
  assert.deepEqual([c.owner, c.acting, c.until], [U.opB, null, '']);
  const tasks = await db.sql<{ id: string; assignee: string }>`SELECT id, assignee_user_id AS assignee FROM tasks WHERE client_id = 'cl-a-2' ORDER BY id`;
  assert.deepEqual(tasks.map((x) => [x.id, x.assignee]), [['tk-tr-act', U.opB], ['tk-tr-own', U.opB]]);
});

test('двойник идёт вместе; двойник с другим владельцем или закрытый — нет', async () => {
  await reset();
  // семья A3–A4–A5 (A5 связан только с A4), A6 — пара с чужим владельцем B1, A7 — пара с закрытой A8
  const pair = (id: string, a: string, b: string, status = 'open') =>
    db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at) VALUES (${id}, ${a}, ${b}, 'shared_phone', ${status}, ${SEED_NOW})`;
  await pair('dp-tr-1', 'cl-a-3', 'cl-a-4');
  await pair('dp-tr-2', 'cl-a-4', 'cl-a-5', 'distinct');
  await pair('dp-tr-3', 'cl-a-6', 'cl-b-1');
  await pair('dp-tr-4', 'cl-a-7', 'cl-a-8');
  await pair('dp-tr-5', 'cl-a-10', 'cl-a-9', 'merged');
  await setCard(db.sql, 'cd-a-8', { state: 'not_interested' });
  const r = await transferOne(rop, { opId: uuid(), cardId: 'cd-a-3', version: 0, toUserId: U.opB });
  assert.deepEqual([r.moved, r.related], [3, 2]);
  for (const id of ['cd-a-3', 'cd-a-4', 'cd-a-5']) assert.equal((await card(id)).owner, U.opB, id);
  assert.equal((await card('cd-a-8')).owner, U.opA, 'закрытый двойник остаётся');
  const r2 = await transferOne(rop, { opId: uuid(), cardId: 'cd-a-6', version: 0, toUserId: U.opB });
  assert.deepEqual([r2.moved, r2.related], [1, 0]);
  assert.equal((await card('cd-b-1')).owner, U.opB);
  const r3 = await transferOne(rop, { opId: uuid(), cardId: 'cd-a-9', version: 0, toUserId: U.opB });
  assert.equal(r3.moved, 1, 'слитая пара не связывает');
  const note = await db.sql<{ params: { count: number } }>`SELECT params FROM notifications WHERE kind = 'client_transferred' ORDER BY created_at, id`;
  assert.equal(note.map((n) => n.params.count).sort().join(), '1,1,3');
});

test('отказы: устаревшая версия, тот же владелец, получатель без права или отключён, чужая карточка', async () => {
  await reset();
  await db.sql`UPDATE cards SET version = 4 WHERE id = 'cd-a-11'`;
  const stale = await failure(transferOne(rop, { opId: uuid(), cardId: 'cd-a-11', version: 3, toUserId: U.opB }));
  assert.ok(stale instanceof TeamError && stale.code === 'conflict' && stale.detail === 'card_changed');
  const same = await failure(transferOne(rop, { opId: uuid(), cardId: 'cd-a-11', version: 4, toUserId: U.opA }));
  assert.ok(same instanceof TeamError && same.detail === 'same_owner');
  for (const who of [U.director, U.consultant, U.disabled, 'u-nobody']) {
    const e = await failure(transferOne(rop, { opId: uuid(), cardId: 'cd-a-11', version: 4, toUserId: who }));
    assert.ok(e instanceof TeamError && e.detail === 'recipient', who);
  }
  assert.ok((await failure(transferOne(rop, { opId: uuid(), cardId: 'cd-zzz', version: 0, toUserId: U.opB }))) instanceof NotFoundError);
  // оператор без права передачи и без охвата карточки B: чужая = несуществующая
  assert.ok((await failure(transferOne(opA, { opId: uuid(), cardId: 'cd-b-2', version: 0, toUserId: U.opA }))) instanceof NotFoundError);
  assert.equal((await card('cd-a-11')).owner, U.opA);
  assert.equal((await db.sql`SELECT 1 FROM assign_log`).length, 0);
});

test('массовая: флаг выключен — 404 на предпросмотре и применении', async () => {
  process.env.FEATURE_BULK_TRANSFER = '0';
  try {
    assert.ok((await failure(previewBulk(rop, { from: U.opA, scope: 'working' }))) instanceof NotFoundError);
    assert.ok((await failure(transferBulk(rop, { opId: uuid(), fromUserId: U.opA, scope: 'working', to: { userId: U.opB } }))) instanceof NotFoundError);
  } finally {
    process.env.FEATURE_BULK_TRANSFER = '1';
  }
});

test('массовая «поровну» между тремя: семьи не делятся, снимок = числу изменённых строк, повтор opId без дублей', async () => {
  await reset();
  // семья из 4 карточек (A1–A4 по цепочке) и 26 одиночных рабочих карточек A5…A30; остальные A — закрыты
  await db.sql`UPDATE cards SET state = 'not_target' WHERE id LIKE 'cd-a-%' AND substring(id from 6)::int > 30`;
  for (const [i, [a, b]] of [['cl-a-1', 'cl-a-2'], ['cl-a-2', 'cl-a-3'], ['cl-a-3', 'cl-a-4']].entries()) {
    await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at) VALUES (${`dp-tr-b${i}`}, ${a}, ${b}, 'shared_phone', 'open', ${SEED_NOW})`;
  }
  const pv = await previewBulk(rop, { from: U.opA, scope: 'working' });
  assert.deepEqual([pv.total, pv.cards.retry, pv.families, pv.tooMany], [30, 30, 27, false]);
  assert.deepEqual([pv.tasks, pv.deals], [1, 1]);
  const all = await previewBulk(rop, { from: U.opA, scope: 'all' });
  assert.equal(all.total, 100);

  const opId = uuid();
  const to = { even: [U.opB, U.duty, U.rop] };
  const r = await transferBulk(rop, { opId, fromUserId: U.opA, scope: 'working', to });
  assert.equal(r.moved, 30);
  assert.deepEqual(Object.values(r.byRecipient).sort(), [10, 10, 10]);
  // семья из 4 у одного получателя
  const fam = await db.sql<{ owner: string }>`SELECT DISTINCT owner_user_id AS owner FROM cards WHERE id IN ('cd-a-1','cd-a-2','cd-a-3','cd-a-4')`;
  assert.equal(fam.length, 1);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.opA} AND state = 'retry'`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.opA}`).length, 70, 'закрытые остались у A');
  // снимок: 30 карточек + задача и сделка клиента A1
  const snaps = await db.sql<{ tableName: string; n: number }>`SELECT table_name, count(*)::int AS n FROM change_snapshots WHERE operation_id = ${opId} GROUP BY table_name ORDER BY table_name`;
  assert.deepEqual(snaps.map((s) => [s.tableName, s.n]), [['cards', 30], ['deals', 1], ['tasks', 1]]);
  const before = await db.sql<{ before: { owner_user_id: string } }>`SELECT before FROM change_snapshots WHERE operation_id = ${opId} AND table_name = 'cards' LIMIT 1`;
  assert.equal(before[0]!.before.owner_user_id, U.opA);
  assert.equal((await db.sql`SELECT 1 FROM assign_log WHERE run_id = ${opId} AND kind = 'transfer' AND NOT counts_to_cap`).length, 30);
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'client_transferred'`).length, 3);
  const again = await transferBulk(rop, { opId, fromUserId: U.opA, scope: 'working', to });
  assert.deepEqual([again.moved, again.replayed], [30, true]);
  assert.equal((await db.sql`SELECT 1 FROM change_snapshots WHERE operation_id = ${opId}`).length, 32);
  // отказы: получатель = источник, слишком мало получателей — на уровне схемы; чужой получатель
  const self = await failure(transferBulk(rop, { opId: uuid(), fromUserId: U.opA, scope: 'working', to: { even: [U.opA, U.opB] } }));
  assert.ok(self instanceof TeamError && self.detail === 'same_owner');
  const bad = await failure(transferBulk(rop, { opId: uuid(), fromUserId: U.opB, scope: 'working', to: { userId: U.director } }));
  assert.ok(bad instanceof TeamError && bad.detail === 'recipient');
});

test('массовая: 1 000 карточек за ≤ 5 с, больше 5 000 — 400 too_many, оператор без охвата ничего не двигает', async () => {
  await reset();
  const t = SEED_NOW;
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
               SELECT 'cl-big-' || i, 'company', 'ТОО Большая ' || i, 'большая ' || i, 'большая ' || i, 'import', ${t}, ${t} FROM generate_series(1, 5100) AS i`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
               SELECT 'cd-big-' || i, ${SPACE}, 'cl-big-' || i, ${U.disabled}, 'retry', ${t}, ${t}, ${t} FROM generate_series(1, 5100) AS i`;
  const tooMany = await failure(transferBulk(rop, { opId: uuid(), fromUserId: U.disabled, scope: 'working', to: { userId: U.opB } }));
  assert.ok(tooMany instanceof TeamError && tooMany.code === 'bad_request' && tooMany.detail === 'too_many');
  assert.equal((await previewBulk(rop, { from: U.disabled, scope: 'working' })).tooMany, true);
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.disabled}`).length, 5100);
  await db.sql`UPDATE cards SET state = 'not_target' WHERE id LIKE 'cd-big-%' AND substring(id from 8)::int > 1000`;
  const started = Date.now();
  const r = await transferBulk(rop, { opId: uuid(), fromUserId: U.disabled, scope: 'working', to: { even: [U.opB, U.duty, U.rop] } });
  assert.equal(r.moved, 1000);
  assert.ok(Date.now() - started <= 5000, `заняло ${Date.now() - started} мс`);
  const snaps = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM change_snapshots WHERE table_name = 'cards'`;
  assert.equal(snaps[0]!.n, 1000);
  // у оператора A нет ни client.transfer, ни охвата чужих карточек: нулевой итог либо отказ, данные не меняются
  const opMove = await failure(transferBulk(opA, { opId: uuid(), fromUserId: U.opB, scope: 'working', to: { userId: U.opA } }));
  assert.ok(opMove !== null || (await db.sql`SELECT 1 FROM cards WHERE owner_user_id = ${U.opA} AND client_id LIKE 'cl-b-%'`).length === 0);
  await db.sql`DELETE FROM change_snapshots`;
  await db.sql`DELETE FROM assign_log WHERE card_id LIKE 'cd-big-%'`;
  await db.sql`DELETE FROM notifications`;
  await db.sql`DELETE FROM client_events WHERE client_id LIKE 'cl-big-%'`;
  await db.sql`DELETE FROM audit_log WHERE action = 'client.transfer'`;
  await db.sql`DELETE FROM cards WHERE id LIKE 'cd-big-%'`;
  await db.sql`DELETE FROM clients WHERE id LIKE 'cl-big-%'`;
});
