// Часть ночной сверки (D-066): рабочие карточки без владельца, кроме `new` (пул).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { countOwnerlessWorkingCards } from '../../../src/server/domain/cards/invariants';
import type { SystemActor } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { closeCallsWorld, openCallsWorld, setCard } from '../calls/world';

let db: TestDb;
const sys = { kind: 'system', job: 'invariants', now: 1 } as SystemActor;

before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

test('считает retry и callback без владельца; пул (new) и закрытые не считает', async () => {
  assert.equal(await countOwnerlessWorkingCards(sys), 0);
  await setCard(db.sql, 'cd-a-1', { owner: null, state: 'new' });
  assert.equal(await countOwnerlessWorkingCards(sys), 0, 'new без владельца — это пул');
  await setCard(db.sql, 'cd-a-2', { owner: null, state: 'retry' });
  await setCard(db.sql, 'cd-a-3', { owner: null, state: 'callback' });
  await setCard(db.sql, 'cd-a-4', { owner: null, state: 'written_off' });
  assert.equal(await countOwnerlessWorkingCards(sys), 2);
});
