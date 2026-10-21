// Покупка (B6, §5.4, D-248): консультант в окне регистрирует покупку по открытой сделке; карточка → «Клиент»,
// лента `deal.won` с id = requestId, передача в отдел со сроком, задача главе отдела, колокол владельцу.
// Повтор того же ключа (последовательно и параллельно) — одна сделка, одна передача, одна задача, один колокол.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { registerPurchase } from '../../../src/server/domain/deals/purchase';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import type { DealsDeps, PurchaseInput } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FRI_18, FX, THU_14, THU_NOON, TEAM_MKT, U, cardState, closeDealsWorld, dealRow, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
let cons: Viewer;
let rop: Viewer;
let opB: Viewer;
const clock = { now: THU_14 };
// Клиент завтрашней консультации консультанта (окно открыто), карточка оператора Б
const C = FX.bkInWindow;

const failsWith = (code: string) => (e: unknown) => e instanceof DealDomainError && e.code === code;
const input = (over: Partial<PurchaseInput> = {}): PurchaseInput => ({
  requestId: uuid(),
  cardId: C.card,
  dealId: 'dl-offer',
  serviceTypeKey: 'smm',
  amountKzt: 450_000,
  wonDay: '2026-10-29',
  ...over,
});
const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;

before(async () => {
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  cons = await viewerOf(U.consultant);
  rop = await viewerOf(U.rop);
  opB = await viewerOf(U.opB);
});
after(() => closeDealsWorld(db));
beforeEach(() => {
  clock.now = THU_14;
});

test('консультант в окне: «Переговоры» → покупка 450 000 ₸, 12:00 дня, карточка → «Клиент», передача со сроком пт 18:00', async () => {
  await seedDeal(db.sql, { id: 'dl-offer', client: C.client, card: C.card, stage: 'offer', owner: U.opB });
  const req = input();
  const res = await registerPurchase(deps, cons, req);
  assert.equal(res.replayed, false);
  assert.deepEqual([res.deal.id, res.deal.status, res.deal.stageKey, res.deal.amountKzt, res.deal.serviceTypeKey, res.deal.wonAt], ['dl-offer', 'won', 'paid', 450_000, 'smm', THU_NOON]);
  assert.equal(await cardState(db.sql, C.card), 'client');

  const feed = await db.sql<{ id: string; kind: string; data: Record<string, unknown> }>`SELECT id, kind, data FROM client_events WHERE id = ${req.requestId}`;
  assert.deepEqual(feed[0]?.data, { dealId: 'dl-offer', fromStage: 'offer', toStage: 'paid', serviceTypeKey: 'smm', amountKzt: 450_000, wonAt: THU_NOON });

  const ho = await db.sql<{ id: string; status: string; dueAt: number; teamId: string }>`SELECT * FROM handoffs WHERE deal_id = 'dl-offer'`;
  assert.deepEqual([ho[0]?.id, ho[0]?.status, ho[0]?.dueAt, ho[0]?.teamId], [res.handoffId, 'pending', FRI_18, TEAM_MKT]);
  const tasks = await db.sql<{ assigneeUserId: string; kind: string; source: string; teamId: string; dueAt: number; dealId: string }>`
    SELECT * FROM tasks WHERE source_key = ${`handoff:${res.handoffId}`} AND status = 'open'`;
  assert.deepEqual(tasks.map((x) => [x.assigneeUserId, x.kind, x.source, x.teamId, x.dueAt, x.dealId]), [[U.mktHead, 'handoff', 'handoff', TEAM_MKT, FRI_18, 'dl-offer']]);
  const bells = await db.sql<{ userId: string; kind: string; params: Record<string, unknown> }>`
    SELECT user_id, kind, params FROM notifications WHERE kind IN ('handoff_new', 'deal_won') AND entity_id IN (${res.handoffId!}, 'dl-offer') ORDER BY kind`;
  assert.deepEqual(bells.map((b) => [b.kind, b.userId]), [['deal_won', U.opB], ['handoff_new', U.mktHead]]);
  // в колоколе только id, без имени клиента
  assert.ok(bells.every((b) => Object.values(b.params).every((v) => typeof v === 'string' && !/Синтетика/.test(v))));
  const audit = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'deal.purchase' AND entity_id = 'dl-offer'`;
  assert.deepEqual(audit[0]?.meta, { dealId: 'dl-offer', serviceTypeKey: 'smm', amountKzt: 450_000, newDeal: false });

  // повтор того же ключа: тот же ответ, ничего нового
  const again = await registerPurchase(deps, cons, req);
  assert.deepEqual([again.replayed, again.deal.id, again.handoffId], [true, 'dl-offer', res.handoffId]);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM handoffs WHERE deal_id = 'dl-offer'`), 1);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM tasks WHERE deal_id = 'dl-offer' AND source = 'handoff'`), 1);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'handoff_new' AND entity_id = ${res.handoffId!}`), 1);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM client_events WHERE deal_id = 'dl-offer' AND kind = 'deal.won'`), 1);
});

test('двойное нажатие: два одновременных запроса с одним ключом и dealId = null → одна новая сделка, одна передача', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = 'cd-b-20'`;
  const req = input({ cardId: 'cd-b-20', dealId: null });
  const [a, b] = await Promise.all([registerPurchase(deps, rop, req), registerPurchase(deps, rop, req)]);
  assert.equal(a.deal.id, b.deal.id);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  const deals = await db.sql<{ id: string; status: string; stageKey: string; requestId: string }>`SELECT * FROM deals WHERE card_id = 'cd-b-20'`;
  assert.deepEqual(deals.map((d) => [d.status, d.stageKey, d.requestId]), [['won', 'paid', req.requestId]]);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM handoffs WHERE deal_id = ${a.deal.id}`), 1);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM tasks WHERE deal_id = ${a.deal.id} AND source = 'handoff' AND status = 'open'`), 1);
  // РОП покупает за карточку оператора Б — колокол владельцу ровно один
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'deal_won' AND entity_id = ${a.deal.id}`), 1);
});

test('тот же ключ на другую карточку → request_reused, ничего не записано', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id IN ('cd-b-21', 'cd-b-22')`;
  const req = input({ cardId: 'cd-b-21', dealId: null, serviceTypeKey: 'master_group' });
  await registerPurchase(deps, rop, req);
  await assert.rejects(registerPurchase(deps, rop, { ...req, cardId: 'cd-b-22' }), failsWith('request_reused'));
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-b-22'`), 0);
  assert.equal(await cardState(db.sql, 'cd-b-22'), 'agreed');
  // параллельно на две карточки с одним ключом: одна проходит, вторая — request_reused
  const req2 = input({ cardId: 'cd-b-23', dealId: null, serviceTypeKey: 'master_group' });
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id IN ('cd-b-23', 'cd-b-24')`;
  const results = await Promise.allSettled([registerPurchase(deps, rop, req2), registerPurchase(deps, rop, { ...req2, cardId: 'cd-b-24' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failsWith('request_reused')(rejected.reason));
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM deals WHERE request_id = ${req2.requestId}`), 1);
});

test('dealId = null при открытой сделке — вторая сделка сразу выиграна; услуга без передачи — передачи нет', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = 'cd-b-25'`;
  await seedDeal(db.sql, { id: 'dl-25', client: 'cl-b-25', card: 'cd-b-25', stage: 'booked' });
  const res = await registerPurchase(deps, rop, input({ cardId: 'cd-b-25', dealId: null, serviceTypeKey: 'master_group', amountKzt: 0 }));
  assert.notEqual(res.deal.id, 'dl-25');
  assert.deepEqual([res.deal.status, res.deal.amountKzt, res.handoffId], ['won', 0, null]);
  assert.equal((await dealRow(db.sql, 'dl-25'))?.status, 'open');
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM handoffs WHERE deal_id = ${res.deal.id}`), 0);
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE deal_id = ${res.deal.id} AND kind = 'deal.won'`;
  assert.equal(feed[0]?.data['fromStage'], null);
});

test('карточка не в «Договорились»/«Перезвон»/«Клиент» → outcome_required, ничего не записано', async () => {
  await db.sql`UPDATE cards SET state = 'retry' WHERE id = 'cd-b-26'`;
  await seedDeal(db.sql, { id: 'dl-26', client: 'cl-b-26', card: 'cd-b-26' });
  await assert.rejects(registerPurchase(deps, rop, input({ cardId: 'cd-b-26', dealId: 'dl-26' })), failsWith('outcome_required'));
  assert.equal((await dealRow(db.sql, 'dl-26'))?.status, 'open');
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM handoffs WHERE deal_id = 'dl-26'`), 0);
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM client_events WHERE deal_id = 'dl-26'`), 0);
});

test('закрытая сделка → deal_closed; сделка другой карточки → 404', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id IN ('cd-b-27', 'cd-b-28')`;
  await seedDeal(db.sql, { id: 'dl-27', client: 'cl-b-27', card: 'cd-b-27' });
  await db.sql`UPDATE deals SET status = 'lost', lost_at = 1, stage_key = 'lost' WHERE id = 'dl-27'`;
  await assert.rejects(registerPurchase(deps, rop, input({ cardId: 'cd-b-27', dealId: 'dl-27' })), failsWith('deal_closed'));
  await seedDeal(db.sql, { id: 'dl-28', client: 'cl-b-28', card: 'cd-b-28' });
  await assert.rejects(registerPurchase(deps, rop, input({ cardId: 'cd-b-27', dealId: 'dl-28' })), (e: unknown) => e instanceof NotFoundError);
});

test('проверки ввода: сумма −1, дробь, строка; дата дальше 36 ч или старше 400 дней; неизвестная услуга', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = 'cd-b-29'`;
  const base = { cardId: 'cd-b-29', dealId: null };
  for (const amountKzt of [-1, 1.5, '450000' as unknown as number, 1e12 + 1]) {
    await assert.rejects(registerPurchase(deps, rop, input({ ...base, amountKzt })), failsWith('amount_invalid'), String(amountKzt));
  }
  await assert.rejects(registerPurchase(deps, rop, input({ ...base, wonDay: '2026-10-31' })), failsWith('won_at_invalid'));
  await assert.rejects(registerPurchase(deps, rop, input({ ...base, wonDay: '2025-09-01' })), failsWith('won_at_invalid'));
  await assert.rejects(registerPurchase(deps, rop, input({ ...base, serviceTypeKey: 'nope' })), failsWith('service_type_unknown'));
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-b-29'`), 0);
});

test('доступ: оператор (нет права), консультант вне окна, чужое пространство — 404; флаг выключен — 404', async () => {
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id IN (${FX.bkPast.card}, 'cd-b-30')`;
  await assert.rejects(registerPurchase(deps, opB, input({ cardId: 'cd-b-30', dealId: null })), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(registerPurchase(deps, cons, input({ cardId: FX.bkPast.card, dealId: null })), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(registerPurchase(deps, rop, input({ cardId: 'нет-такой', dealId: null })), (e: unknown) => e instanceof NotFoundError);
  process.env['FEATURE_PURCHASES'] = '0';
  try {
    await assert.rejects(registerPurchase(deps, rop, input({ cardId: 'cd-b-30', dealId: null })), (e: unknown) => e instanceof NotFoundError);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
  assert.equal(await count(db.sql`SELECT count(*)::int AS n FROM deals WHERE card_id IN (${FX.bkPast.card}, 'cd-b-30')`), 0);
});

test('покупка из «Перезвона» закрывает перезвон; повторная покупка клиента оставляет «Клиент»', async () => {
  await db.sql`UPDATE cards SET state = 'callback', next_call_at = ${THU_14} WHERE id = 'cd-b-31'`;
  const first = await registerPurchase(deps, rop, input({ cardId: 'cd-b-31', dealId: null, serviceTypeKey: 'master_group' }));
  assert.equal(first.deal.status, 'won');
  assert.equal(await cardState(db.sql, 'cd-b-31'), 'client');
  const second = await registerPurchase(deps, rop, input({ cardId: 'cd-b-31', dealId: null, serviceTypeKey: 'master_group', amountKzt: 1000 }));
  assert.notEqual(second.deal.id, first.deal.id);
  assert.equal(await cardState(db.sql, 'cd-b-31'), 'client');
});
