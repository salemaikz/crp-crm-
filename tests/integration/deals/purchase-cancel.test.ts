// Правка и отмена покупки (B6, §5.5, D-249): «возврат» → проигран с причиной refund, «ошибка» → прежний этап
// (сделка, созданная сразу выигранной, → проигран с input_error); передача отменяется, задачи сняты, отделу колокол;
// карточка → «Перезвон» или «Договорились», а при другой покупке клиента остаётся «Клиент». Правка суммы — РОП.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { cancelPurchase, editPurchase, registerPurchase } from '../../../src/server/domain/deals/purchase';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import type { DealsDeps } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { THU_14, THU_NOON, U, cardState, closeDealsWorld, dealRow, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
let rop: Viewer;
let cons: Viewer;
const clock = { now: THU_14 };
const failsWith = (code: string) => (e: unknown) => e instanceof DealDomainError && e.code === code;
const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;

/** Карточка n оператора Б в «Договорились», сделка на «Переговорах» и покупка услуги с передачей. */
async function bought(n: number, o: { service?: string; newDeal?: boolean } = {}): Promise<{ dealId: string; handoffId: string | null; version: number }> {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${`cd-b-${n}`}`;
  if (!o.newDeal) await seedDeal(db.sql, { id: `dl-c${n}`, client: `cl-b-${n}`, card: `cd-b-${n}`, stage: 'offer', owner: U.opB });
  const r = await registerPurchase(deps, rop, {
    requestId: uuid(),
    cardId: `cd-b-${n}`,
    dealId: o.newDeal ? null : `dl-c${n}`,
    serviceTypeKey: o.service ?? 'smm',
    amountKzt: 300_000,
    wonDay: '2026-10-29',
  });
  return { dealId: r.deal.id, handoffId: r.handoffId, version: r.deal.version };
}

before(async () => {
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  rop = await viewerOf(U.rop);
  cons = await viewerOf(U.consultant);
});
after(() => closeDealsWorld(db));

test('возврат: проигран/refund, передача отменена, задачи сняты, отделу колокол, карточка → «Перезвон» (открытых нет)', async () => {
  const b = await bought(40);
  // глава назначил исполнителя — колокол уйдёт обоим
  await db.sql`UPDATE handoffs SET status = 'accepted', assignee_user_id = ${U.marketer} WHERE id = ${b.handoffId!}`;
  const opId = uuid();
  const v = await cancelPurchase(deps, rop, { dealId: b.dealId, opId, version: b.version, mode: 'refund', comment: 'Клиент вернул оплату' });
  assert.deepEqual([v.status, v.stageKey, v.lostReasonCode, v.amountKzt], ['lost', 'lost', 'refund', 300_000]);
  assert.equal((await db.sql<{ status: string }>`SELECT status FROM handoffs WHERE id = ${b.handoffId!}`)[0]?.status, 'cancelled');
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM tasks WHERE deal_id = ${b.dealId} AND source = 'handoff' AND status = 'open'`), 0);
  const bells = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'handoff_cancelled' AND entity_id = ${b.handoffId!} ORDER BY user_id`;
  assert.deepEqual(bells.map((x) => x.userId), [U.mktHead, U.marketer].sort());
  assert.equal(await cardState(db.sql, 'cd-b-40'), 'callback');
  // комментарий — заметка по сделке; в ленте и аудите текста нет
  const note = await db.sql<{ body: string; dealId: string }>`SELECT body, deal_id FROM notes WHERE deal_id = ${b.dealId}`;
  assert.deepEqual(note.map((x) => x.body), ['Клиент вернул оплату']);
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE id = ${opId}`;
  assert.deepEqual(feed[0]?.data, { dealId: b.dealId, mode: 'refund' });
  const audit = await db.sql<{ meta: unknown }>`SELECT meta FROM audit_log WHERE action = 'deal.purchase_cancel' AND entity_id = ${b.dealId}`;
  assert.ok(!JSON.stringify(audit).includes('вернул'));
  // повтор того же opId — то же состояние, второго события нет
  const again = await cancelPurchase(deps, rop, { dealId: b.dealId, opId, version: b.version, mode: 'refund', comment: 'Клиент вернул оплату' });
  assert.equal(again.status, 'lost');
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM client_events WHERE deal_id = ${b.dealId} AND kind = 'deal.purchase_cancelled'`), 1);
});

test('возврат при другой открытой сделке клиента → карточка «Договорились»', async () => {
  const b = await bought(41);
  await seedDeal(db.sql, { id: 'dl-41-other', client: 'cl-b-41', card: 'cd-b-41', stage: 'booked' });
  await cancelPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: b.version, mode: 'refund', comment: 'Возврат' });
  assert.equal(await cardState(db.sql, 'cd-b-41'), 'agreed');
});

test('ошибка после «Переговоров» → снова «Переговоры», сумма 0, без услуги; карточка «Договорились»', async () => {
  const b = await bought(42);
  const v = await cancelPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: b.version, mode: 'error', comment: 'Не тот клиент' });
  assert.deepEqual([v.status, v.stageKey, v.amountKzt, v.serviceTypeKey, v.wonAt], ['open', 'offer', 0, '', null]);
  assert.equal(await cardState(db.sql, 'cd-b-42'), 'agreed');

  // повторная покупка той же сделки → передача снова pending, задача главе снова открыта
  const again = await registerPurchase(deps, rop, { requestId: uuid(), cardId: 'cd-b-42', dealId: b.dealId, serviceTypeKey: 'smm', amountKzt: 350_000, wonDay: null });
  assert.equal(again.handoffId, b.handoffId);
  const ho = await db.sql<{ status: string; assigneeUserId: string | null }>`SELECT * FROM handoffs WHERE deal_id = ${b.dealId}`;
  assert.deepEqual([ho.length, ho[0]?.status, ho[0]?.assigneeUserId], [1, 'pending', null]);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM tasks WHERE source_key = ${`handoff:${b.handoffId}`} AND status = 'open'`), 1);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'handoff_new' AND entity_id = ${b.handoffId!}`), 2);
});

test('ошибка у сделки, созданной сразу выигранной → проигран/input_error', async () => {
  const b = await bought(43, { newDeal: true, service: 'master_group' });
  const v = await cancelPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: b.version, mode: 'error', comment: 'Ошибка' });
  assert.deepEqual([v.status, v.lostReasonCode], ['lost', 'input_error']);
  assert.equal(await cardState(db.sql, 'cd-b-43'), 'callback');
});

test('у клиента вторая выигранная сделка → карточка остаётся «Клиент»', async () => {
  const first = await bought(44, { service: 'master_group' });
  const second = await registerPurchase(deps, rop, { requestId: uuid(), cardId: 'cd-b-44', dealId: null, serviceTypeKey: 'master_group', amountKzt: 1000, wonDay: null });
  assert.equal(await cardState(db.sql, 'cd-b-44'), 'client');
  await cancelPurchase(deps, rop, { dealId: second.deal.id, opId: uuid(), version: second.deal.version, mode: 'refund', comment: 'Возврат' });
  assert.equal(await cardState(db.sql, 'cd-b-44'), 'client');
  assert.equal((await dealRow(db.sql, first.dealId))?.status, 'won');
});

test('правка суммы и даты: лента и аудит с числами, без ПДн; смена услуги → service_type_locked; версия; не выигранная', async () => {
  const b = await bought(45);
  const opId = uuid();
  const v = await editPurchase(deps, rop, { dealId: b.dealId, opId, version: b.version, amountKzt: 280_000, wonDay: '2026-10-28' });
  const wed = Date.UTC(2026, 9, 28, 7, 0);
  assert.deepEqual([v.amountKzt, v.wonAt, v.version], [280_000, wed, b.version + 1]);
  const audit = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'deal.purchase_edit' AND entity_id = ${b.dealId}`;
  assert.deepEqual(audit[0]?.meta, { dealId: b.dealId, fromAmount: 300_000, toAmount: 280_000, fromWonAt: THU_NOON, toWonAt: wed });
  // повтор opId — без второй правки
  await editPurchase(deps, rop, { dealId: b.dealId, opId, version: b.version, amountKzt: 280_000 });
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM client_events WHERE deal_id = ${b.dealId} AND kind = 'deal.purchase_edited'`), 1);

  await assert.rejects(editPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: v.version, serviceTypeKey: 'master_group' }), failsWith('service_type_locked'));
  await assert.rejects(editPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: b.version, amountKzt: 1 }), (e: unknown) => e instanceof ConflictError);
  await assert.rejects(editPurchase(deps, rop, { dealId: b.dealId, opId: uuid(), version: v.version, amountKzt: 1.5 }), failsWith('amount_invalid'));
  await seedDeal(db.sql, { id: 'dl-open-45', client: 'cl-b-45', card: 'cd-b-45' });
  await assert.rejects(editPurchase(deps, rop, { dealId: 'dl-open-45', opId: uuid(), version: 0, amountKzt: 1 }), failsWith('deal_not_won'));
  await assert.rejects(cancelPurchase(deps, rop, { dealId: 'dl-open-45', opId: uuid(), version: 0, mode: 'refund', comment: 'x' }), failsWith('deal_not_won'));
});

test('правка и отмена — только РОП: консультант в окне получает 404', async () => {
  const b = await bought(46);
  await assert.rejects(editPurchase(deps, cons, { dealId: b.dealId, opId: uuid(), version: b.version, amountKzt: 1 }), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(cancelPurchase(deps, cons, { dealId: b.dealId, opId: uuid(), version: b.version, mode: 'refund', comment: 'x' }), (e: unknown) => e instanceof NotFoundError);
  assert.equal((await dealRow(db.sql, b.dealId))?.status, 'won');
});
