// Снимок карточки читает колонки воронки v2: причину и касания перезвона, точность срока (иначе версия растёт
// без изменений, а касания становятся NaN). Мир звонков, синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { loadSnapshot, lockCardUnscoped } from '../../../src/server/domain/cards/repo';
import { closeCallsWorld, openCallsWorld } from '../calls/world';

let db: TestDb;
before(async () => { db = await openCallsWorld(); });
after(async () => { await closeCallsWorld(db); });

test('lockCardUnscoped и loadSnapshot отдают callbackReason, callbackTouches, nextCallPrecision', async () => {
  const id = 'cd-a-1';
  await db.sql`UPDATE cards SET callback_reason = 'think', callback_touches = 2, next_call_precision = 'day' WHERE id = ${id}`;
  try {
    await db.tx(async (tx) => {
      const locked = await lockCardUnscoped(tx, id);
      assert.equal(locked?.snapshot.callbackReason, 'think');
      assert.equal(locked?.snapshot.callbackTouches, 2);
      assert.equal(locked?.snapshot.nextCallPrecision, 'day');
      const snap = await loadSnapshot(tx, id);
      assert.equal(snap?.snapshot.callbackTouches, 2);
      assert.equal(snap?.snapshot.nextCallPrecision, 'day');
    });
  } finally {
    await db.sql`UPDATE cards SET callback_reason = '', callback_touches = 0, next_call_precision = 'time' WHERE id = ${id}`;
  }
});
