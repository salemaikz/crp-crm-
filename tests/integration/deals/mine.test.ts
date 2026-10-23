// «Мои покупки» (B1, pipeline-v2 §9.5): отбор по заслуге — автор первой записи сделки, а не текущий владелец
// карточки. После передачи карточки продажа остаётся у автора, чужие продажи на новых клиентах в список не попадают;
// название клиента видно, только пока карточка в охвате зрителя.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { listMine, monthBounds } from '../../../src/server/domain/deals/mine';
import type { DealsDeps } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { seedBookings, seedEvent } from '../booking/helpers';
import { THU_14, THU_NOON, U, closeDealsWorld, makeDealsDeps, openDealsWorld, seedDeal, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
let opA: Viewer;
let opB: Viewer;
let mkt: Viewer;
let rop: Viewer;
const clock = { now: THU_14 };

/** Выигранная сделка карточки; единственная запись сделки — от `author`. */
async function wonDeal(n: number, a: { id: string; client: string; card: string; owner: string; author: string; amount: number; wonAt?: number }): Promise<void> {
  await seedDeal(db.sql, { id: a.id, client: a.client, card: a.card, stage: 'paid', owner: a.owner, status: 'won' });
  await db.sql`UPDATE deals SET amount_kzt = ${a.amount}, service_type_key = 'smm', won_at = ${a.wonAt ?? THU_NOON} WHERE id = ${a.id}`;
  const [bk] = await seedBookings(db.sql, `ev-mine-${n}`, [{ client: a.client, card: a.card }], { bookedBy: a.author });
  await db.sql`UPDATE bookings SET deal_id = ${a.id} WHERE id = ${bk!}`;
}

before(async () => {
  process.env['FEATURE_OP_BOARD'] = '1';
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  mkt = await viewerOf(U.marketer);
  rop = await viewerOf(U.rop);
  for (const n of [1, 2, 3, 4]) await seedEvent(db.sql, { id: `ev-mine-${n}`, date: '2026-10-20', time: '15:00' });
  await wonDeal(1, { id: 'dl-m1', client: 'cl-a-30', card: 'cd-a-30', owner: U.opA, author: U.opA, amount: 100_000 });
  await wonDeal(2, { id: 'dl-m2', client: 'cl-a-31', card: 'cd-a-31', owner: U.opA, author: U.opB, amount: 200_000 });
  // прошлый месяц: в списке есть, в итоге месяца нет
  await wonDeal(3, { id: 'dl-m3', client: 'cl-a-32', card: 'cd-a-32', owner: U.opA, author: U.opA, amount: 50_000, wonAt: Date.UTC(2026, 8, 10, 6, 0) });
});
after(async () => {
  delete process.env['FEATURE_OP_BOARD'];
  await closeDealsWorld(db);
});

test('границы месяца считаются в поясе установки', () => {
  const b = monthBounds('Asia/Almaty', Date.UTC(2026, 9, 31, 20, 0)); // 01.11 01:00 по Алматы
  assert.equal(b.fromMs, Date.UTC(2026, 9, 31, 19, 0));
  assert.equal(b.toMs, Date.UTC(2026, 10, 30, 19, 0));
  assert.equal(monthBounds('Asia/Almaty', Date.UTC(2026, 11, 15)).toMs, Date.UTC(2026, 11, 31, 19, 0));
});

test('автор видит свои сделки с названием клиента и итогом месяца; чужие продажи на его клиентах — нет', async () => {
  const r = await listMine(deps, opA);
  assert.deepEqual(r.items.map((i) => i.dealId), ['dl-m1', 'dl-m3']);
  assert.deepEqual(r.items.map((i) => [i.amountKzt, i.serviceTypeKey, i.clientTransferred]), [[100_000, 'smm', false], [50_000, 'smm', false]]);
  assert.ok(r.items.every((i) => i.clientName !== null && i.clientId !== null));
  assert.deepEqual(r.month, { count: 1, sumKzt: 100_000 });
});

test('после передачи карточки продажа остаётся у автора без названия клиента и не появляется у нового владельца', async () => {
  await db.sql`UPDATE cards SET owner_user_id = ${U.opB} WHERE id = 'cd-a-30'`;
  const a = await listMine(deps, opA);
  const m1 = a.items.find((i) => i.dealId === 'dl-m1')!;
  assert.deepEqual([m1.clientTransferred, m1.clientName, m1.clientId, m1.amountKzt], [true, null, null, 100_000]);
  const name = (await db.sql<{ name: string }>`SELECT name FROM clients WHERE id = 'cl-a-30'`)[0]!.name;
  assert.equal(JSON.stringify(a).includes(name), false, 'имени ушедшего клиента в ответе нет');
  assert.deepEqual(a.month, { count: 1, sumKzt: 100_000 });

  const b = await listMine(deps, opB);
  assert.deepEqual(b.items.map((i) => i.dealId), ['dl-m2'], 'у нового владельца только своя заслуга');
  assert.equal(b.items[0]!.clientTransferred, true, 'клиент dl-m2 у А: В охвате его нет');
  assert.equal(b.items[0]!.clientName, null);
  assert.deepEqual(b.month, { count: 1, sumKzt: 200_000 });
});

test('сотрудник без заслуг — пустой список (РОП своих продаж не засчитывает чужие); отдел передачи — 404', async () => {
  const r = await listMine(deps, rop);
  assert.deepEqual([r.items, r.month], [[], { count: 0, sumKzt: 0 }]);
  await assert.rejects(listMine(deps, mkt), NotFoundError);
});

test('флаг покупок выключен — 404 как на несуществующее', async () => {
  delete process.env['FEATURE_PURCHASES'];
  try {
    await assert.rejects(listMine(deps, opA), NotFoundError);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
});

test('«Мои покупки» — часть доски: OP_BOARD выключен при включённом PURCHASES — 404', async () => {
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    await assert.rejects(listMine(deps, opA), NotFoundError);
  } finally {
    process.env['FEATURE_OP_BOARD'] = '1';
  }
});
