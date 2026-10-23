// Покупка и её отмена пересчитывают кэш карточки в своей транзакции (B1, pipeline-v2 §5.1): purchases_total,
// last_purchase_at и горячесть; при любом состоянии карточки, включая «Клиент» с другой покупкой.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { cancelPurchase, registerPurchase } from '../../../src/server/domain/deals/purchase';
import type { DealsDeps } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { THU_14, THU_NOON, U, closeDealsWorld, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
let rop: Viewer;
const clock = { now: THU_14 };
const cache = async (card: string) => (await db.sql<{ purchasesTotal: number; lastPurchaseAt: number | null; version: number }>`SELECT purchases_total, last_purchase_at, version FROM cards WHERE id = ${card}`)[0]!;

before(async () => {
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  rop = await viewerOf(U.rop);
});
after(() => closeDealsWorld(db));

test('покупка поднимает purchases_total и last_purchase_at, отмена возвращает; «Клиент» с другой покупкой остаётся «Клиентом»', async () => {
  await seedDeal(db.sql, { id: 'dl-pd1', client: 'cl-b-60', card: 'cd-b-60', stage: 'offer', owner: U.opB });
  await seedDeal(db.sql, { id: 'dl-pd2', client: 'cl-b-60', card: 'cd-b-60', stage: 'offer', owner: U.opB });
  assert.equal((await cache('cd-b-60')).purchasesTotal, 0);
  const p1 = await registerPurchase(deps, rop, { requestId: uuid(), cardId: 'cd-b-60', dealId: 'dl-pd1', serviceTypeKey: 'smm', amountKzt: 100_000, wonDay: '2026-10-29' });
  let c = await cache('cd-b-60');
  assert.deepEqual([c.purchasesTotal, Number(c.lastPurchaseAt)], [1, THU_NOON]);
  const p2 = await registerPurchase(deps, rop, { requestId: uuid(), cardId: 'cd-b-60', dealId: 'dl-pd2', serviceTypeKey: 'smm', amountKzt: 100_000, wonDay: '2026-10-29' });
  assert.equal((await cache('cd-b-60')).purchasesTotal, 2);
  // отмена одной из двух: карточка остаётся «Клиентом», но счётчик уже 1
  await cancelPurchase(deps, rop, { dealId: p2.deal.id, opId: uuid(), version: p2.deal.version, mode: 'refund', comment: 'Возврат' });
  c = await cache('cd-b-60');
  assert.equal(c.purchasesTotal, 1);
  assert.equal((await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = 'cd-b-60'`)[0]?.state, 'client');
  await cancelPurchase(deps, rop, { dealId: p1.deal.id, opId: uuid(), version: p1.deal.version, mode: 'refund', comment: 'Возврат' });
  c = await cache('cd-b-60');
  assert.deepEqual([c.purchasesTotal, c.lastPurchaseAt], [0, null]);
});
