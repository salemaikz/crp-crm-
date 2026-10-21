// Маршруты сделок (B6, §5.3, §6) через обёртку route(): коды ответов (201/200 повтор, 400 с кодом, 409 с кодом и
// полями, 403/404 по правам, 423 директору), флаг PURCHASES выключен — 404. Плюс чтение: страница сделки и форма покупки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { overrideDealsDepsForTests } from '../../../src/server/domain/deals/deps';
import { getDealPage, getPurchaseForm } from '../../../src/server/domain/deals/read';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as purchaseRoute from '../../../src/app/api/deals/purchase/route';
import * as dealRoute from '../../../src/app/api/deals/[id]/route';
import * as editRoute from '../../../src/app/api/deals/[id]/purchase/route';
import * as cancelRoute from '../../../src/app/api/deals/[id]/cancel-purchase/route';
import * as stageRoute from '../../../src/app/api/deals/[id]/stage/route';
import * as loseRoute from '../../../src/app/api/deals/[id]/lose/route';
import { FX, THU_14, U, actAs, closeDealsWorld, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

const ORIGIN = 'http://crm.test';
type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
interface Reply {
  status: number;
  json: Record<string, unknown>;
}

let db: TestDb;
const clock = { now: THU_14 };
const C = FX.bkInWindow;

async function call(handler: Handler, method: string, o: { as: string | null; body?: unknown; id?: string }): Promise<Reply> {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}/x`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), {
    params: Promise.resolve(o.id ? { id: o.id } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

before(async () => {
  db = await openDealsWorld();
  overrideDealsDepsForTests(makeDealsDeps(clock));
  await seedDeal(db.sql, { id: 'dl-r1', client: C.client, card: C.card, stage: 'offer', owner: U.opB });
});
after(async () => {
  overrideDealsDepsForTests(null);
  await closeDealsWorld(db);
});

test('форма покупки консультанта: открытая сделка по умолчанию, услуги с признаком передачи, сегодня', async () => {
  const cons = await viewerOf(U.consultant);
  const form = await getPurchaseForm(makeDealsDeps(clock), cons, { cardId: C.card, locale: 'ru' });
  assert.deepEqual([form.allowed, form.defaultDealId, form.today, form.openDeals.map((d) => d.id)], [true, 'dl-r1', '2026-10-29', ['dl-r1']]);
  assert.deepEqual(form.serviceTypes.map((s) => [s.key, s.routesToTeam]), [['smm', true], ['master_group', false], ['design', true]]);
});

test('покупка: 201, повтор — 200; сумма строкой — 400 amount_invalid; оператор — 403; страница сделки', async () => {
  const body = { requestId: uuid(), cardId: C.card, dealId: 'dl-r1', serviceTypeKey: 'smm', amountKzt: 450_000, wonDay: '2026-10-29' };
  const bad = await call(purchaseRoute.POST, 'POST', { as: U.consultant, body: { ...body, amountKzt: '450000' } });
  assert.deepEqual([bad.status, bad.json.detail], [400, 'amount_invalid']);
  const frac = await call(purchaseRoute.POST, 'POST', { as: U.consultant, body: { ...body, amountKzt: 1.5 } });
  assert.deepEqual([frac.status, frac.json.detail], [400, 'amount_invalid']);
  const first = await call(purchaseRoute.POST, 'POST', { as: U.consultant, body });
  assert.equal(first.status, 201);
  const again = await call(purchaseRoute.POST, 'POST', { as: U.consultant, body });
  assert.deepEqual([again.status, again.json.replayed], [200, true]);
  const op = await call(purchaseRoute.POST, 'POST', { as: U.opB, body: { ...body, requestId: uuid() } });
  assert.equal(op.status, 403);

  const page = await call(dealRoute.GET, 'GET', { as: U.consultant, id: 'dl-r1' });
  assert.equal(page.status, 200);
  const deal = page.json.deal as Record<string, unknown>;
  assert.deepEqual([deal.status, deal.amountKzt], ['won', 450_000]);
  assert.deepEqual(page.json.can, { purchase: false, editStage: false, moveBack: false, lose: false, editPurchase: false });
  const kinds = (page.json.history as Array<{ kind: string }>).map((h) => h.kind);
  assert.ok(kinds.includes('deal.won') && kinds.includes('handoff.created'));
  assert.equal((page.json.handoff as { status: string }).status, 'pending');
  // у РОП — правка и отмена покупки
  const ropView = await getDealPage(makeDealsDeps(clock), await viewerOf(U.rop), 'dl-r1');
  assert.deepEqual(ropView.can, { purchase: false, editStage: false, moveBack: false, lose: false, editPurchase: true });
  // оператор А — сделка оператора Б: 404
  assert.equal((await call(dealRoute.GET, 'GET', { as: U.opA, id: 'dl-r1' })).status, 404);
});

test('правка: смена услуги — 409 service_type_locked; этап без полей — 409 с полями; директор — 423', async () => {
  const v = (await db.sql<{ version: number }>`SELECT version FROM deals WHERE id = 'dl-r1'`)[0]!.version;
  const locked = await call(editRoute.PATCH, 'PATCH', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: v, serviceTypeKey: 'master_group' } });
  assert.deepEqual([locked.status, locked.json.detail], [409, 'service_type_locked']);
  const ok = await call(editRoute.PATCH, 'PATCH', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: v, amountKzt: 400_000 } });
  assert.deepEqual([ok.status, ok.json.amountKzt], [200, 400_000]);

  await seedDeal(db.sql, { id: 'dl-r2', client: 'cl-b-90', card: 'cd-b-90', stage: 'booked' });
  const fields = await call(stageRoute.POST, 'POST', { as: U.rop, id: 'dl-r2', body: { opId: uuid(), version: 0, stageKey: 'contract', nextStep: null } });
  assert.deepEqual([fields.status, fields.json.detail, fields.json.fields], [409, 'stage_fields_required', ['budget']]);
  const won = await call(stageRoute.POST, 'POST', { as: U.rop, id: 'dl-r2', body: { opId: uuid(), version: 0, stageKey: 'paid', nextStep: null } });
  assert.deepEqual([won.status, won.json.detail], [400, 'use_purchase']);

  const director = await call(loseRoute.POST, 'POST', { as: U.director, id: 'dl-r2', body: { opId: uuid(), version: 0, reasonCode: 'no_time', reasonText: '' } });
  assert.equal(director.status, 423);
  const cancel = await call(cancelRoute.POST, 'POST', { as: U.rop, id: 'dl-r2', body: { opId: uuid(), version: 0, mode: 'refund', comment: 'x' } });
  assert.deepEqual([cancel.status, cancel.json.detail], [409, 'deal_not_won']);
});

test('флаг PURCHASES выключен: все маршруты сделок — 404', async () => {
  process.env['FEATURE_PURCHASES'] = '0';
  try {
    const replies = [
      await call(purchaseRoute.POST, 'POST', { as: U.rop, body: { requestId: uuid(), cardId: 'cd-b-91', dealId: null, serviceTypeKey: 'smm', amountKzt: 1, wonDay: null } }),
      await call(dealRoute.GET, 'GET', { as: U.rop, id: 'dl-r1' }),
      await call(editRoute.PATCH, 'PATCH', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: 0, amountKzt: 1 } }),
      await call(cancelRoute.POST, 'POST', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: 0, mode: 'refund', comment: 'x' } }),
      await call(stageRoute.POST, 'POST', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: 0, stageKey: 'offer', nextStep: null } }),
      await call(loseRoute.POST, 'POST', { as: U.rop, id: 'dl-r1', body: { opId: uuid(), version: 0, reasonCode: 'no_time', reasonText: '' } }),
    ];
    assert.deepEqual(replies.map((r) => r.status), [404, 404, 404, 404, 404, 404]);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
});
