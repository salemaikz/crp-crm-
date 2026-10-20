// Автозадачи (D-050): идемпотентность по source_key, закрытие по источникам и ключу, передача, «мои открытые».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { closeAutoTaskByKey, closeAutoTasks, ensureAutoTask, listMyOpenTasks, reassignOpenTasks } from '../../../src/server/domain/tasks/auto';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { SEED_NOW, closeCallsWorld, openCallsWorld, viewerOf } from '../calls/world';

let db: TestDb;
let opA: Viewer;
let rop: Viewer;

const base = { spaceId: SPACE, clientId: 'cl-a-40', kind: 'call' as const, assigneeUserId: U.opA, dueAt: SEED_NOW + 1000, at: SEED_NOW };
const openOf = async (client: string) => db.sql<{ source: string; sourceKey: string; assigneeUserId: string; title: string; createdBy: string | null }>`
  SELECT source, source_key, assignee_user_id, title, created_by FROM tasks WHERE client_id = ${client} AND status = 'open' ORDER BY source_key`;

before(async () => {
  db = await openCallsWorld();
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
});
after(() => closeCallsWorld(db));

test('создание идемпотентно: открытая задача с тем же ключом не задваивается', async () => {
  const a = await db.tx((tx) => ensureAutoTask(tx, opA, { ...base, source: 'callback', sourceKey: 'callback:op-1' }));
  const b = await db.tx((tx) => ensureAutoTask(tx, opA, { ...base, source: 'callback', sourceKey: 'callback:op-1' }));
  assert.equal(a.created, true);
  assert.deepEqual([b.created, b.id], [false, a.id]);
  const rows = await openOf('cl-a-40');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.title, rows[0]!.createdBy], ['', U.opA]);
});

test('закрытая задача ключ не держит: новая с тем же ключом создаётся', async () => {
  await db.tx((tx) => closeAutoTaskByKey(tx, opA, { sourceKey: 'callback:op-1', at: SEED_NOW }));
  const again = await db.tx((tx) => ensureAutoTask(tx, opA, { ...base, source: 'callback', sourceKey: 'callback:op-1' }));
  assert.equal(again.created, true);
});

test('параллельное создание с одним ключом даёт одну задачу', async () => {
  const rs = await Promise.all(
    Array.from({ length: 5 }, () => db.tx((tx) => ensureAutoTask(tx, opA, { ...base, clientId: 'cl-a-41', source: 'review', kind: 'check', sourceKey: 'review:op-par' }))),
  );
  assert.equal(rs.filter((r) => r.created).length, 1);
  assert.equal(new Set(rs.map((r) => r.id)).size, 1);
});

test('закрытие по источникам и «все»; передача открытых другому исполнителю', async () => {
  const c = { ...base, clientId: 'cl-a-42' };
  await db.tx(async (tx) => {
    await ensureAutoTask(tx, opA, { ...c, source: 'callback', sourceKey: 'callback:x' });
    await ensureAutoTask(tx, opA, { ...c, source: 'review', kind: 'check', sourceKey: 'review:x' });
    await ensureAutoTask(tx, opA, { ...c, source: 'no_show', sourceKey: 'no_show:x' });
  });
  const moved = await db.tx((tx) => reassignOpenTasks(tx, rop, { spaceId: SPACE, clientId: 'cl-a-42', fromUserIds: [U.opA], toUserId: U.opB, at: SEED_NOW }));
  assert.equal(moved, 3);
  assert.ok((await openOf('cl-a-42')).every((t) => t.assigneeUserId === U.opB));
  assert.equal(await db.tx((tx) => closeAutoTasks(tx, opA, { spaceId: SPACE, clientId: 'cl-a-42', sources: ['callback', 'no_show'], at: SEED_NOW })), 2);
  assert.deepEqual((await openOf('cl-a-42')).map((t) => t.source), ['review']);
  assert.equal(await db.tx((tx) => closeAutoTasks(tx, opA, { spaceId: SPACE, clientId: 'cl-a-42', sources: 'all', at: SEED_NOW })), 1);
  assert.equal((await openOf('cl-a-42')).length, 0);
});

test('закрытие не трогает задачи других клиентов', async () => {
  assert.ok((await openOf('cl-a-40')).length >= 1);
  assert.ok((await openOf('cl-a-41')).length === 1);
});

test('мои открытые: своё по охвату, просроченные сверху, без срока — в конце', async () => {
  const c = { ...base, clientId: 'cl-a-43' };
  await db.tx(async (tx) => {
    await ensureAutoTask(tx, opA, { ...c, source: 'callback', sourceKey: 'cb:late', dueAt: SEED_NOW + 5000 });
    await ensureAutoTask(tx, opA, { ...c, source: 'review', kind: 'check', sourceKey: 'cb:none', dueAt: null });
    await ensureAutoTask(tx, opA, { ...c, source: 'no_show', sourceKey: 'cb:early', dueAt: SEED_NOW - 5000 });
  });
  const mine = await listMyOpenTasks(opA, { limit: 50, sources: ['callback', 'review', 'no_show'] });
  const keys = mine.filter((t) => t.clientId === 'cl-a-43').map((t) => t.source);
  assert.deepEqual(keys, ['no_show', 'callback', 'review']);
  const other = await listMyOpenTasks(await viewerOf(U.opB), { limit: 50 });
  assert.ok(other.every((t) => t.clientId !== 'cl-a-43'), 'чужие задачи не отдаются');
});

test('передача забирает задачи прежнего и временного владельца, задачи РОП без исполнителя и чужие остаются (D-254)', async () => {
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, status, source_key, created_at) VALUES
      ('tk-re-own', ${SPACE}, 'cl-a-44', 'call', 'callback', '', ${U.opA}, 'open', 're:own', ${SEED_NOW}),
      ('tk-re-act', ${SPACE}, 'cl-a-44', 'call', 'no_show', '', ${U.opB}, 'open', 're:act', ${SEED_NOW}),
      ('tk-re-rop', ${SPACE}, 'cl-a-44', 'check', 'review', '', ${U.rop}, 'open', 're:rop', ${SEED_NOW}),
      ('tk-re-nul', ${SPACE}, 'cl-a-44', 'check', 'stoplist_confirm', '', NULL, 'open', 're:nul', ${SEED_NOW})`;
  const moved = await db.tx((tx) => reassignOpenTasks(tx, rop, { spaceId: SPACE, clientId: 'cl-a-44', fromUserIds: [U.opA, U.opB], toUserId: U.consultant, at: SEED_NOW }));
  assert.equal(moved, 2);
  const rows = await db.sql<{ id: string; assigneeUserId: string | null }>`SELECT id, assignee_user_id FROM tasks WHERE id LIKE 'tk-re-%' ORDER BY id`;
  assert.deepEqual(rows.map((r) => [r.id, r.assigneeUserId]), [['tk-re-act', U.consultant], ['tk-re-nul', null], ['tk-re-own', U.consultant], ['tk-re-rop', U.rop]]);
  assert.equal(await db.tx((tx) => reassignOpenTasks(tx, rop, { spaceId: SPACE, clientId: 'cl-a-44', fromUserIds: [], toUserId: U.opA, at: SEED_NOW })), 0);
});
