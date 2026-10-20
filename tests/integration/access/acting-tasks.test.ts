// Охват задач временного владельца (D-252, docs/tasks-team-design.md §4.6): на время «Отсутствует» временный
// видит и закрывает задачи владельца по карточкам, где он временный, — и только их. Задачи не переназначаются:
// снятие временного само возвращает видимость владельцу, у временного — тот же 404, что у несуществующей.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSql, scoped, throwNotFoundOrConflict } from '../../../src/server/access/scope';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { SPACE, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from './world';

let db: TestDb;
const t = 1_800_000_000_000;
const acted = { card: cardOf('a', 11), client: clientOf('a', 11) };
const other = { card: cardOf('a', 12), client: clientOf('a', 12) };

before(async () => {
  db = await openWorld();
  const add = (id: string, client: string, assignee: string | null) =>
    db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
           VALUES (${id}, ${SPACE}, ${client}, 'call', 'manual', 'Синтетика', ${assignee}, ${t})`;
  await add('tk-act-owner', acted.client, U.opA); // задача владельца по карточке, где Б временный
  await add('tk-act-rop', acted.client, U.rop); // задача РОП по той же карточке — не владельца
  await add('tk-act-none', acted.client, null); // без исполнителя
  await add('tk-act-other', other.client, U.opA); // задача владельца по карточке без временного
});
after(() => closeWorld(db));

async function visible(v: Viewer, perm: 'task.read' | 'task.write'): Promise<string[]> {
  const rows = await scoped(db.sql)<{ id: string }>`
    SELECT t.id FROM tasks t WHERE t.id LIKE 'tk-act-%' AND ${scopeSql(v, 'task', perm)} ORDER BY t.id`;
  return rows.map((r) => r.id);
}

test('временный видит и пишет задачи владельца только по своим временным карточкам; после снятия — 404', async () => {
  const B = await viewerOf(U.opB);
  assert.deepEqual(await visible(B, 'task.read'), []);

  await db.sql`UPDATE cards SET acting_user_id = ${U.opB}, acting_until_day = '2026-10-30' WHERE id = ${acted.card}`;
  assert.deepEqual(await visible(B, 'task.read'), ['tk-act-owner']);
  assert.deepEqual(await visible(B, 'task.write'), ['tk-act-owner']);
  // Владелец свою задачу по-прежнему видит: задачи не переназначались
  const A = await viewerOf(U.opA);
  assert.deepEqual(await visible(A, 'task.read'), ['tk-act-other', 'tk-act-owner']);

  await db.sql`UPDATE cards SET acting_user_id = NULL, acting_until_day = '' WHERE id = ${acted.card}`;
  assert.deepEqual(await visible(B, 'task.read'), []);
  await assert.rejects(throwNotFoundOrConflict(B, db.sql, 'task', 'tk-act-owner'), { code: 'not_found' });
});

test('временный владелец чужой карточки не видит задачи другого исполнителя, даже если тот — владелец другой карточки', async () => {
  // Б временный у карточки A11, но задача оформлена на РОП (не владельца) — не видна; карточка A12 без временного — тоже
  await db.sql`UPDATE cards SET acting_user_id = ${U.opB}, acting_until_day = '2026-10-30' WHERE id = ${acted.card}`;
  try {
    const B = await viewerOf(U.opB);
    const ids = await visible(B, 'task.read');
    assert.equal(ids.includes('tk-act-rop'), false);
    assert.equal(ids.includes('tk-act-none'), false);
    assert.equal(ids.includes('tk-act-other'), false);
    // Директор (только чтение) видит всё на чтение и ничего на запись — правка охвата его не касается
    const dir = await viewerOf(U.director);
    assert.deepEqual(await visible(dir, 'task.read'), ['tk-act-none', 'tk-act-other', 'tk-act-owner', 'tk-act-rop']);
    assert.deepEqual(await visible(dir, 'task.write'), []);
  } finally {
    await db.sql`UPDATE cards SET acting_user_id = NULL, acting_until_day = '' WHERE id = ${acted.card}`;
  }
});
