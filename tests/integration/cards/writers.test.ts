// Обходные пути записи cards и цикл перезвона (pipeline-v2 §5.4, W1): импорт и возврат проигравшей карточки в пул
// сбрасывают причину и касания, передача другому оператору цикл сохраняет.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { updateCardFromImport, type CardUpdate } from '../../../src/server/domain/import/repo';
import { retireLoserCard } from '../../../src/server/domain/intake/mergeRepo';
import { writeMoves } from '../../../src/server/domain/team/transferRepo';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeCallsWorld, openCallsWorld, setCard } from '../calls/world';

let db: TestDb;
before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

const cycleOf = async (id: string) =>
  (await db.sql<{ state: string; reason: string; touches: number; version: number }>`
    SELECT state, callback_reason AS reason, callback_touches AS touches, version FROM cards WHERE id = ${id}`)[0]!;

async function seedCycle(i: number): Promise<string> {
  const id = cardOf('a', i);
  await setCard(db.sql, id, { state: 'callback', owner: U.opA });
  await db.sql`UPDATE cards SET callback_reason = 'thinking', callback_touches = 3 WHERE id = ${id}`;
  return id;
}

const update = (state: string): CardUpdate => ({
  ownerUserId: U.opA, assignedAt: SEED_NOW, state, holdReason: '', attempts: 0, nextCallAt: null, returnAt: null, lpr: '',
  isTarget: '', lastOutcomeCode: '', lastOutcomeKind: '', lastOutcomeAt: null, closeReasonCode: '', closedAt: null,
  callsTotal: 0, connectsTotal: 0, noAnswerTotal: 0, firstConnectAt: null, lastConnectAt: null, lastTouchAt: null,
});

test('импорт ставит state new: причина пуста, касаний 0', async () => {
  const id = await seedCycle(71);
  const before = await cycleOf(id);
  assert.equal(await updateCardFromImport(db.sql, id, before.version, update('new'), SEED_NOW), true);
  const after = await cycleOf(id);
  assert.deepEqual([after.state, after.reason, after.touches], ['new', '', 0]);
});

test('импорт оставляет callback: цикл сохраняется', async () => {
  const id = await seedCycle(72);
  const before = await cycleOf(id);
  assert.equal(await updateCardFromImport(db.sql, id, before.version, update('callback'), SEED_NOW), true);
  const after = await cycleOf(id);
  assert.deepEqual([after.reason, after.touches], ['thinking', 3]);
});

test('слияние: проигравшая карточка, возвращённая в пул, теряет цикл', async () => {
  const id = await seedCycle(73);
  await db.tx((tx) => retireLoserCard(tx, { cardId: id, now: SEED_NOW }));
  const after = await cycleOf(id);
  assert.deepEqual([after.reason, after.touches], ['', 0]);
});

test('передача другому оператору цикл сохраняет', async () => {
  const id = await seedCycle(74);
  await db.tx((tx) =>
    writeMoves(tx, {
      spaceId: SPACE, opId: globalThis.crypto.randomUUID(), actorId: null, now: SEED_NOW, day: '2026-10-28', snapshot: false,
      moves: [{ cardId: id, clientId: clientOf('a', 74), fromUserId: U.opA, actingUserId: null, toUserId: U.opB }],
    }),
  );
  const after = await cycleOf(id);
  assert.deepEqual([after.state, after.reason, after.touches], ['callback', 'thinking', 3]);
});
