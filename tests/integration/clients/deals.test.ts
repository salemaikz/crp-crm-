// История сделок клиента (C8 §3.5): в пределах охвата deal.read, новые сверху, не больше 50, подписи — из настроек.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import { getClientDeals, loadClientPage } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, SPACE, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

async function addDeal(id: string, i: number, status: 'open' | 'won' | 'lost', createdAt: number, owner: string = U.opA) {
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt,
                                  won_at, lost_at, lost_reason_code, stage_changed_at, created_by, created_at, updated_at)
               VALUES (${id}, ${SPACE}, 'sales', ${status === 'open' ? 'negotiation' : status}, ${status}, ${clientOf('a', i)}, ${cardOf('a', i)}, ${owner}, 'smm',
                       ${status === 'won' ? 450000 : 0}, ${status === 'won' ? createdAt + 1000 : null}, ${status === 'lost' ? createdAt + 1000 : null},
                       ${status === 'lost' ? 'price' : ''}, ${createdAt}, ${owner}, ${createdAt}, ${createdAt})`;
}

test('сделки клиента: новые сверху, статусы, суммы в тенге и владелец', async () => {
  const i = 60;
  await addDeal('dh-1', i, 'lost', SEED_NOW - 3000);
  await addDeal('dh-2', i, 'won', SEED_NOW - 2000);
  await addDeal('dh-3', i, 'open', SEED_NOW - 1000);
  const rows = await getClientDeals(await viewerOf(U.opA), clientOf('a', i));
  assert.deepEqual(rows.map((r) => r.id), ['dh-3', 'dh-2', 'dh-1']);
  assert.equal(rows[1]?.amountKzt, 450000);
  assert.equal(rows[1]?.wonAt, SEED_NOW - 1000);
  assert.equal(rows[2]?.lostReasonCode, 'price');
  assert.equal(rows[0]?.ownerName, 'Оператор Синтетик А');
});

test('не больше 50 сделок', async () => {
  const i = 61;
  for (let k = 0; k < 53; k++) await addDeal(`dh-big-${k}`, i, 'open', SEED_NOW - k * 10);
  const rows = await getClientDeals(await viewerOf(U.opA), clientOf('a', i));
  assert.equal(rows.length, 50);
});

test('сделки отдаются только в пределах охвата: чужой клиент — 404, консультанту без deal.read пусто', async () => {
  const i = 62;
  await addDeal('dh-own', i, 'open', SEED_NOW);
  const a = await viewerOf(U.opA);
  assert.equal((await getClientDeals(a, clientOf('a', i))).length, 1);
  await assert.rejects(() => getClientDeals(a, clientOf('b', i)), NotFoundError);
  // Консультант клиента B2 видит запись, но сделок (deal.read) нет
  const cons = await viewerOf(U.consultant);
  const rows = await getClientDeals(cons, clientOf('b', 2));
  assert.deepEqual(rows, []);
});

test('страница клиента несёт сделки, подписи этапов и закреплённые заметки', async () => {
  const page = await loadClientPage(await viewerOf(U.opA), clientOf('a', 1));
  assert.equal(page.kind, 'ok');
  if (page.kind !== 'ok') return;
  assert.ok(page.deals.some((d) => d.id === 'dl-a-1'));
  assert.deepEqual(page.pinnedNotes, []);
  assert.ok(typeof page.summary.calls.total === 'number');
  assert.ok(Object.keys(page.catalog.stages).length > 0);
});

test('отдел передачи (D-300): на странице клиента только сделка передачи и без сумм — ни в списке, ни в итоге', async () => {
  const cl = clientOf('b', 7);
  await db.sql`UPDATE deals SET service_type_key = 'smm', amount_kzt = 990002 WHERE id = 'dl-b7'`;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt,
                                  won_at, stage_changed_at, created_by, created_at, updated_at)
               VALUES ('dh-dept-other', ${SPACE}, 'sales', 'won', 'won', ${cl}, ${cardOf('b', 7)}, ${U.opB}, 'smm', 990001,
                       ${SEED_NOW}, ${SEED_NOW}, ${U.opB}, ${SEED_NOW}, ${SEED_NOW})`;
  for (const who of [U.mktHead, U.marketer]) {
    const v = await viewerOf(who);
    const rows = await getClientDeals(v, cl);
    assert.deepEqual(rows.map((r) => [r.id, r.amountKzt]), [['dl-b7', null]], who);
    const page = await loadClientPage(v, cl);
    assert.equal(page.kind, 'ok');
    if (page.kind !== 'ok') return;
    assert.deepEqual(page.deals.map((d) => d.id), ['dl-b7'], who);
    assert.deepEqual(page.summary.purchases.map((p) => p.amountKzt), [null], who);
    assert.ok(!/99000[12]/.test(JSON.stringify({ deals: page.deals, summary: page.summary, feed: page.feed })), `сумма в странице клиента у ${who}`);
  }
  // РОП (охват роли) видит обе сделки с суммами
  const rop = await getClientDeals(await viewerOf(U.rop), cl);
  assert.deepEqual(rop.map((r) => r.amountKzt).sort(), [990001, 990002]);
});
