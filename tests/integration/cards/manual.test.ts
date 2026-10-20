// Ручные переходы карточки (D-251, D-254): runCardEvent / applyCardEventLocked. transfer забирает задачи прежнего
// и временного владельца (задачи РОП не трогает), открытые сделки идут за карточкой, opId ложится в assign_log.run_id,
// устаревшая версия — CardActionError, чужая карточка — NotFoundError.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { CardActionError } from '../../../src/server/domain/cards/errors';
import { runCardEvent } from '../../../src/server/domain/cards/manual';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U, cardOf } from '../../isolation/harness/seed';
import { SEED_NOW, closeCallsWorld, openCallsWorld, setCard, uuid, viewerOf } from '../calls/world';

let db: TestDb;
let rop: Viewer;
let opB: Viewer;

before(async () => {
  db = await openCallsWorld();
  rop = await viewerOf(U.rop);
  opB = await viewerOf(U.opB);
});
after(() => closeCallsWorld(db));

test('transfer: карточка, задачи прежнего и временного, сделка, журнал с opId', async () => {
  await setCard(db.sql, 'cd-a-45', { state: 'retry', owner: U.opA, acting: U.opB });
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, status, source_key, created_at) VALUES
      ('tk-m-own', ${SPACE}, 'cl-a-45', 'call', 'callback', '', ${U.opA}, 'open', 'm:own', ${SEED_NOW}),
      ('tk-m-act', ${SPACE}, 'cl-a-45', 'call', 'no_show', '', ${U.opB}, 'open', 'm:act', ${SEED_NOW}),
      ('tk-m-rop', ${SPACE}, 'cl-a-45', 'check', 'review', '', ${U.rop}, 'open', 'm:rop', ${SEED_NOW})`;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
               VALUES ('dl-m-1', ${SPACE}, 'sales', 'booked', 'open', 'cl-a-45', 'cd-a-45', ${U.opA}, ${SEED_NOW}, ${SEED_NOW}, ${SEED_NOW})`;
  const version = (await db.sql<{ version: number }>`SELECT version FROM cards WHERE id = 'cd-a-45'`)[0]!.version;
  const opId = uuid();

  const res = await runCardEvent(rop, cardOf('a', 45), 'card.assign', (snap) => ({ type: 'transfer', opId, toUserId: U.consultant, seenVersion: snap.version, facts: { toUserActive: true } }) as never, { opId, now: SEED_NOW });
  assert.equal(res.card.ownerUserId, U.consultant);
  assert.equal(res.card.actingUserId, null);
  assert.equal(res.card.version, version + 1);

  const tasks = await db.sql<{ id: string; assigneeUserId: string }>`SELECT id, assignee_user_id FROM tasks WHERE id LIKE 'tk-m-%' ORDER BY id`;
  assert.deepEqual(tasks.map((t) => [t.id, t.assigneeUserId]), [['tk-m-act', U.consultant], ['tk-m-own', U.consultant], ['tk-m-rop', U.rop]]);
  const [deal] = await db.sql<{ ownerUserId: string }>`SELECT owner_user_id FROM deals WHERE id = 'dl-m-1'`;
  assert.equal(deal?.ownerUserId, U.consultant);
  const log = await db.sql<{ runId: string; kind: string; countsToCap: boolean }>`SELECT run_id, kind, counts_to_cap FROM assign_log WHERE card_id = 'cd-a-45' AND kind = 'transfer'`;
  assert.deepEqual(log.map((l) => [l.runId, l.countsToCap]), [[opId, false]]);
});

test('устаревшая версия — CardActionError card_changed 409; чужая карточка — NotFoundError', async () => {
  await setCard(db.sql, 'cd-a-46', { state: 'retry', owner: U.opA });
  const transfer = (seen: number) => (snap: { version: number }) => ({ type: 'transfer', opId: uuid(), toUserId: U.opB, seenVersion: seen + snap.version * 0, facts: { toUserActive: true } }) as never;
  await assert.rejects(runCardEvent(rop, cardOf('a', 46), 'card.assign', transfer(9999), { now: SEED_NOW }), (e: unknown) => {
    assert.ok(e instanceof CardActionError);
    assert.deepEqual([e.status, e.body.error], [409, 'card_changed']);
    return true;
  });
  // оператор без card.assign: карточки для него нет
  await assert.rejects(runCardEvent(opB, cardOf('a', 46), 'card.assign', transfer(0), { now: SEED_NOW }), NotFoundError);
});
