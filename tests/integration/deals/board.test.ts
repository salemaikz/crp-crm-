// Доски (B8): сделки по этапам и вид «Обзвон». Охват в SQL, «чего не хватает» из настроек этапов, курсоры, флаг.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError, NotFoundError } from '../../../src/server/access';
import { getCallingBoard, getCallingColumn, getClosedDeals, getDealsBoard, getDealsColumn, overrideBoardDepsForTests } from '../../../src/server/domain/deals';
import type { DealPipelineInfo } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U, closeWorld, openWorld, viewerOf } from '../reports/helpers';
import { testViewer } from '../../../src/server/access/testing';
import type { RoleConfig } from '@crm/core/access';
import { configDoc } from '../../isolation/harness/config';
import { SEED_TZ } from '../../isolation/harness/seed';

const DAY = 86_400_000;
let db: TestDb;

const req = (over: Partial<DealPipelineInfo['stages'][number]['requires']> = {}) => ({
  fields: [], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false, ...over,
});
const stage = (key: string, kind: 'open' | 'won' | 'lost', order: number, requires = req(), staleDays: number | null = null) => ({
  key, label: { ru: key }, kind, order, requires, staleDays, auto: null,
});
const PIPELINES: DealPipelineInfo[] = [
  {
    key: 'sales',
    label: { ru: 'Продажи' },
    createDealOn: 'agreed',
    stages: [
      stage('negotiation', 'open', 10, req(), 3),
      stage('offer', 'open', 20, req({ booking: true, nextTask: true })),
      stage('contract', 'open', 30, req({ attendance: true, fields: ['budget'] })),
      stage('won', 'won', 90),
      stage('lost', 'lost', 99),
    ],
  },
];

before(async () => {
  process.env.FEATURE_KANBAN = '1';
  db = await openWorld();
  overrideBoardDepsForTests({ pipelines: async () => PIPELINES, now: () => SEED_NOW });
  const t = SEED_NOW - 5 * DAY;
  // dl-a-1 (оператор A) и dl-b-1 (оператор B) уже на этапе negotiation; добавим сделки и закрытые
  await db.sql`UPDATE deals SET stage_changed_at = ${t} WHERE id IN ('dl-a-1', 'dl-b-1')`;
  for (const [id, who, n, stageKey, status] of [
    ['dl-a-2', 'a', 2, 'offer', 'open'],
    ['dl-a-3', 'a', 3, 'contract', 'open'],
    ['dl-a-4', 'a', 4, 'won', 'won'],
    ['dl-a-5', 'a', 5, 'lost', 'lost'],
  ] as const) {
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at,
                                    won_at, lost_at, created_by, created_at, updated_at)
                 VALUES (${id}, ${SPACE}, 'sales', ${stageKey}, ${status}, ${`cl-${who}-${n}`}, ${`cd-${who}-${n}`}, ${U.opA}, ${SEED_NOW - DAY},
                         ${status === 'won' ? SEED_NOW - DAY : null}, ${status === 'lost' ? SEED_NOW - 40 * DAY : null}, ${U.opA}, ${t}, ${t})`;
  }
  // следующий шаг у dl-a-2
  await db.sql`UPDATE tasks SET deal_id = 'dl-a-2', due_at = ${SEED_NOW + DAY} WHERE id = 'tk-a-1'`;
});
after(async () => {
  delete process.env.FEATURE_KANBAN;
  overrideBoardDepsForTests(null);
  await closeWorld(db);
});

test('РОП видит сделки обоих операторов по колонкам, закрытые — счётчиком за 30 дней', async () => {
  const board = await getDealsBoard(await viewerOf(U.rop));
  assert.equal(board.pipeline.key, 'sales');
  assert.deepEqual(board.columns.map((c) => [c.stageKey, c.total]), [['negotiation', 2], ['offer', 1], ['contract', 1]]);
  assert.ok(board.closed.won30d >= 1);
  assert.equal(board.closed.lost30d, 0, 'проигранная 40 дней назад в окно не входит');
});

test('оператор видит только свои сделки (охват в SQL)', async () => {
  const board = await getDealsBoard(await viewerOf(U.opA));
  const ids = board.columns.flatMap((c) => c.deals.map((d) => d.id)).sort();
  assert.deepEqual(ids, ['dl-a-1', 'dl-a-2', 'dl-a-3']);
  assert.ok(!JSON.stringify(board).includes('Бета'));
});

test('номер и ЛПР на плитке — по охвату client.read, а не по охвату сделки', async () => {
  await db.sql`INSERT INTO contacts (id, client_id, name, is_decision_maker, created_at) VALUES ('ct-b-1-dm', 'cl-b-1', 'ЛПР Синтетик Бета', TRUE, ${SEED_NOW})`;
  try {
    const tile = (b: Awaited<ReturnType<typeof getDealsBoard>>) => b.columns.flatMap((c) => c.deals).find((d) => d.id === 'dl-b-1')!;
    const full = tile(await getDealsBoard(await viewerOf(U.rop)));
    assert.ok(full.phone, 'контроль: РОП с client.read на пространство видит номер');
    assert.equal(full.contactName, 'ЛПР Синтетик Бета');
    // Сделки — на всё пространство, клиенты — только свои: чужая сделка видна, её номер и ЛПР — нет
    const roles = (configDoc() as { global: { roles: RoleConfig[] } }).global.roles;
    const rop = roles.find((r) => r.key === 'rop')!;
    const narrow: RoleConfig = { ...rop, grants: rop.grants.map((g) => (g.perm === 'client.read' ? { ...g, scope: 'own' } : g)) };
    const v = testViewer({ userId: U.rop, role: narrow, spaceId: SPACE, now: SEED_NOW, timeZone: SEED_TZ });
    const t = tile(await getDealsBoard(v));
    assert.ok(t, 'сделка видна по deal.read на пространство');
    assert.equal(t.phone, null);
    assert.equal(t.contactName, null);
  } finally {
    await db.sql`DELETE FROM contacts WHERE id = 'ct-b-1-dm'`;
  }
});

test('недостающее считается по каждому открытому этапу; залежалась по staleDays', async () => {
  const board = await getDealsBoard(await viewerOf(U.rop));
  const tile = (id: string) => board.columns.flatMap((c) => c.deals).find((d) => d.id === id)!;
  const a1 = tile('dl-a-1');
  assert.deepEqual(a1.missing.offer, ['booking', 'next_step']);
  assert.deepEqual(a1.missing.contract, ['attendance', 'field:budget']);
  assert.deepEqual(a1.missing.negotiation, []);
  assert.equal(a1.badges.staleDays, 5);
  const a2 = tile('dl-a-2');
  assert.deepEqual(a2.missing.offer, ['booking'], 'следующий шаг есть, записи нет');
  assert.equal(a2.nextTask?.id, 'tk-a-1');
  assert.equal(a2.badges.staleDays, null);
});

test('фильтр по владельцу и неизвестная воронка', async () => {
  const rop = await viewerOf(U.rop);
  const mine = await getDealsBoard(rop, { owner: U.opB });
  assert.deepEqual(mine.columns.flatMap((c) => c.deals.map((d) => d.id)), ['dl-b-1']);
  await assert.rejects(() => getDealsBoard(rop, { pipeline: 'нет такой' }), NotFoundError);
});

test('«ещё» в колонке идёт по курсору без повторов', async () => {
  const sql = db.sql;
  const t = SEED_NOW - 2 * DAY;
  for (let i = 1; i <= 60; i++) {
    await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_by, created_at, updated_at)
              VALUES (${`dl-m-${String(i).padStart(2, '0')}`}, ${SPACE}, 'sales', 'negotiation', 'open', 'cl-a-10', 'cd-a-10', ${U.opA}, ${t + i}, ${U.opA}, ${t}, ${t})`;
  }
  const rop = await viewerOf(U.rop);
  const first = (await getDealsBoard(rop)).columns.find((c) => c.stageKey === 'negotiation')!;
  assert.equal(first.deals.length, 50);
  assert.equal(first.total, 62);
  assert.ok(first.nextCursor);
  const next = await getDealsColumn(rop, { stage: 'negotiation', after: first.nextCursor });
  assert.equal(next.deals.length, 12);
  assert.equal(next.nextCursor, null);
  const all = new Set([...first.deals, ...next.deals].map((d) => d.id));
  assert.equal(all.size, 62);
  await assert.rejects(() => getDealsColumn(rop, { stage: 'won', after: null }), NotFoundError);
});

test('закрытые сделки — только чтение, выигранные и проигранные', async () => {
  const closed = await getClosedDeals(await viewerOf(U.rop), { before: null });
  const mine = closed.deals.filter((d) => d.id === 'dl-a-4' || d.id === 'dl-a-5').map((d) => [d.id, d.status]).sort();
  assert.deepEqual(mine, [['dl-a-4', 'won'], ['dl-a-5', 'lost']]);
  assert.ok(closed.deals.every((d) => Object.keys(d.missing).length === 0));
});

test('права на действия: директор — только чтение', async () => {
  const dir = await getDealsBoard(await viewerOf(U.director));
  assert.deepEqual(dir.can, { edit: false, moveBack: false, purchase: false, lose: false });
  const rop = await getDealsBoard(await viewerOf(U.rop));
  assert.equal(rop.can.edit, true);
});

test('вид «Обзвон»: карточки с владельцем по состояниям, оператору — 403', async () => {
  await db.sql`UPDATE cards SET state = 'callback', next_call_at = ${SEED_NOW + DAY} WHERE id IN ('cd-a-2', 'cd-b-2')`;
  await db.sql`UPDATE cards SET state = 'agreed', last_outcome_at = ${SEED_NOW - DAY} WHERE id = 'cd-a-3'`;
  await db.sql`UPDATE cards SET state = 'not_interested', closed_at = ${SEED_NOW - DAY} WHERE id = 'cd-a-4'`;
  const rop = await viewerOf(U.rop);
  const board = await getCallingBoard(rop);
  const total = (s: string) => board.columns.find((c) => c.state === s)!.total;
  assert.equal(total('callback'), 2);
  assert.equal(total('agreed'), 1);
  assert.equal(total('new'), 0);
  assert.ok(total('retry') > 100, 'остальные карточки операторов в состоянии retry');
  assert.equal(board.closed, 1);
  assert.equal(board.can.move, true);
  const cb = board.columns.find((c) => c.state === 'callback')!.cards[0]!;
  assert.match(cb.phones[0]!.masked, /•/);
  assert.ok(!JSON.stringify(board).includes('77090'), 'цифры номеров на доску не идут');

  const onlyB = await getCallingBoard(rop, { worker: U.opB });
  assert.equal(onlyB.columns.find((c) => c.state === 'callback')!.total, 1);

  const page = await getCallingColumn(rop, { state: 'retry', offset: 50 });
  assert.equal(page.cards.length, 50);
  await assert.rejects(() => getCallingColumn(rop, { state: 'closed', offset: 0 }), NotFoundError);

  await assert.rejects(async () => getCallingBoard(await viewerOf(U.opA)), ForbiddenError);
  assert.equal((await getCallingBoard(await viewerOf(U.director))).can.move, false);
});

test('на удержании (hold_reason) и без владельца карточек в «Обзвоне» нет', async () => {
  await db.sql`UPDATE cards SET state = 'callback', hold_reason = 'dup_pair' WHERE id = 'cd-a-6'`;
  await db.sql`UPDATE cards SET state = 'callback', owner_user_id = NULL WHERE id = 'cd-a-7'`;
  const board = await getCallingBoard(await viewerOf(U.rop));
  assert.equal(board.columns.find((c) => c.state === 'callback')!.total, 2);
});

test('флаг FEATURE_KANBAN выключен — обе доски отвечают 404', async () => {
  const rop = await viewerOf(U.rop);
  process.env.FEATURE_KANBAN = '0';
  try {
    await assert.rejects(() => getDealsBoard(rop), NotFoundError);
    await assert.rejects(() => getCallingBoard(rop), NotFoundError);
  } finally {
    process.env.FEATURE_KANBAN = '1';
  }
});
