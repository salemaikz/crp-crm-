// Очередь отдаёт число прошлых перезвонов: по нему шторка считает «N-е касание» (pipeline-v2 §4.2).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getQueue } from '../../../src/server/domain/calls/queue';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { HOUR, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
before(async () => {
  db = await openCallsWorld();
  deps = callsDeps({ now: SEED_NOW });
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  await setCard(db.sql, 'cd-a-3', { state: 'callback', nextCallAt: SEED_NOW - HOUR });
  await db.sql`UPDATE cards SET callback_touches = 2 WHERE id = 'cd-a-3'`;
});
after(() => closeCallsWorld(db));

test('карточка очереди несёт callbackTouches', async () => {
  const r = await getQueue(deps, await viewerOf(U.opA), { limit: 4, exclude: [], group: 'all' });
  assert.equal(r.items.find((i) => i.cardId === 'cd-a-3')?.callbackTouches, 2);
});
