// Исполнитель эффектов покупки (B6, §5.8): `win`, `cancel_purchase`, `lose` по уже записанной сервисом сделке —
// пустые операции; `win` по открытой сделке без сервиса — полная покупка с `won_at = at` (и передача по услуге);
// `win` с `dealId = null` — новая выигранная, повтор ключа ничего не задваивает; `cancel_purchase` по выигранной — «возврат».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { systemActor } from '../../../src/server/access/systemActor';
import { applyDealEffects } from '../../../src/server/domain/deals/effects';
import { loadDealsSettings } from '../../../src/server/domain/deals/settings';
import type { LockedCard } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, THU_14, U, closeDealsWorld, dealRow, openDealsWorld, seedDeal, uuid } from './helpers';

let db: TestDb;
const actor = systemActor('test-deals-win', THU_14);
const card = (n: number): LockedCard => ({ id: `cd-a-${n}`, clientId: `cl-a-${n}`, spaceId: SPACE, state: 'agreed', ownerUserId: U.opA, actingUserId: null, lastOutcomeAt: null, version: 0 });
const run = (n: number, effects: Parameters<typeof applyDealEffects>[3]) => db.tx((tx) => applyDealEffects(tx, actor, card(n), effects, THU_14, { settings: loadDealsSettings }));
const snapshot = async (id: string) => JSON.stringify([await dealRow(db.sql, id), (await db.sql`SELECT kind FROM client_events WHERE deal_id = ${id} ORDER BY at, id`).length]);

before(async () => {
  db = await openDealsWorld();
});
after(() => closeDealsWorld(db));

test('win, lose, cancel_purchase по уже записанной сделке — без изменений', async () => {
  await seedDeal(db.sql, { id: 'dl-w1', client: 'cl-a-70', card: 'cd-a-70', stage: 'paid', status: 'won' });
  const won = await snapshot('dl-w1');
  await run(70, [{ op: 'win', dealId: 'dl-w1', serviceTypeKey: 'smm', amountKzt: 5, requestId: uuid() }]);
  assert.equal(await snapshot('dl-w1'), won);

  await seedDeal(db.sql, { id: 'dl-w2', client: 'cl-a-71', card: 'cd-a-71', stage: 'lost', status: 'lost' });
  const lost = await snapshot('dl-w2');
  await run(71, [{ op: 'lose', dealId: 'dl-w2', reasonGroup: 'deal_lost', reasonCode: 'no_time' }, { op: 'cancel_purchase', dealId: 'dl-w2' }]);
  assert.equal(await snapshot('dl-w2'), lost);
});

test('win по открытой сделке без сервиса — полная покупка с won_at = at и передачей; повтор ключа — ничего', async () => {
  await seedDeal(db.sql, { id: 'dl-w3', client: 'cl-a-72', card: 'cd-a-72', stage: 'offer' });
  const requestId = uuid();
  await run(72, [{ op: 'win', dealId: 'dl-w3', serviceTypeKey: 'smm', amountKzt: 120_000, requestId }]);
  const d = await dealRow(db.sql, 'dl-w3');
  assert.deepEqual([d?.status, d?.stageKey, d?.amountKzt, d?.wonAt, d?.serviceTypeKey], ['won', 'paid', 120_000, THU_14, 'smm']);
  assert.equal((await db.sql`SELECT 1 FROM handoffs WHERE deal_id = 'dl-w3' AND status = 'pending'`).length, 1);
  const before = await snapshot('dl-w3');
  await run(72, [{ op: 'win', dealId: 'dl-w3', serviceTypeKey: 'smm', amountKzt: 120_000, requestId }]);
  assert.equal(await snapshot('dl-w3'), before);
});

test('win с dealId = null — новая выигранная сделка; повтор ключа её не задваивает', async () => {
  const requestId = uuid();
  await run(73, [{ op: 'win', dealId: null, serviceTypeKey: 'master_group', amountKzt: 1000, requestId }]);
  await run(73, [{ op: 'win', dealId: null, serviceTypeKey: 'master_group', amountKzt: 1000, requestId }]);
  const rows = await db.sql<{ status: string; requestId: string }>`SELECT status, request_id FROM deals WHERE card_id = 'cd-a-73'`;
  assert.deepEqual(rows.map((r) => [r.status, r.requestId]), [['won', requestId]]);
});

test('win по проигранной — ошибка сборки; cancel_purchase по выигранной — как возврат', async () => {
  await seedDeal(db.sql, { id: 'dl-w4', client: 'cl-a-74', card: 'cd-a-74', stage: 'lost', status: 'lost' });
  await assert.rejects(run(74, [{ op: 'win', dealId: 'dl-w4', serviceTypeKey: 'smm', amountKzt: 1, requestId: uuid() }]), /проигранной/);
  const requestId = uuid();
  await seedDeal(db.sql, { id: 'dl-w5', client: 'cl-a-75', card: 'cd-a-75', stage: 'offer' });
  await run(75, [{ op: 'win', dealId: 'dl-w5', serviceTypeKey: 'smm', amountKzt: 10, requestId }]);
  await run(75, [{ op: 'cancel_purchase', dealId: 'dl-w5' }]);
  const d = await dealRow(db.sql, 'dl-w5');
  assert.deepEqual([d?.status, d?.lostReasonCode], ['lost', 'refund']);
  assert.equal((await db.sql<{ status: string }>`SELECT status FROM handoffs WHERE deal_id = 'dl-w5'`)[0]?.status, 'cancelled');
});
