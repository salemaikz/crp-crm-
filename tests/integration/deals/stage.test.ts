// Ручной этап и проигрыш (B6, §5.7, PROCESS 4.2, 3.5 № 21): требования этапа (шаг с датой, поля, явка), назад —
// только РОП, «Покупка»/«Проигран» целью — 400, версия; проигрыш последней открытой сделки из «Договорились»
// уводит карточку в «Не интересует» (мягкая) / «Не целевой» (жёсткая, будущие записи отменены).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { loseDeal, moveDealStage } from '../../../src/server/domain/deals/stage';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import type { DealsDeps } from '../../../src/server/domain/deals/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { addConsultant, insertGrey, seedBookings, seedEvent } from '../booking/helpers';
import { DAY, FX, THU_14, U, cardState, closeDealsWorld, dealRow, makeDealsDeps, openDealsWorld, seedDeal, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: DealsDeps;
let rop: Viewer;
let cons: Viewer;
let opB: Viewer;
let dir: Viewer;
const clock = { now: THU_14 };
const failsWith = (code: string) => (e: unknown) => e instanceof DealDomainError && e.code === code;
const move = (v: Viewer, dealId: string, stageKey: string, version: number, nextStep: { dueAt: number; kind: 'call' | 'meeting' } | null = null) =>
  moveDealStage(deps, v, { dealId, opId: uuid(), version, stageKey, nextStep });

before(async () => {
  db = await openDealsWorld();
  deps = makeDealsDeps(clock);
  rop = await viewerOf(U.rop);
  cons = await viewerOf(U.consultant);
  opB = await viewerOf(U.opB);
  dir = await viewerOf(U.director);
});
after(() => closeDealsWorld(db));

test('вперёд на «Переговоры» без шага → next_step_required; с шагом — ручная задача и событие ленты', async () => {
  await seedDeal(db.sql, { id: 'dl-s1', client: 'cl-b-50', card: 'cd-b-50', stage: 'booked' });
  await assert.rejects(move(rop, 'dl-s1', 'offer', 0), failsWith('next_step_required'));
  const opId = uuid();
  const v = await moveDealStage(deps, rop, { dealId: 'dl-s1', opId, version: 0, stageKey: 'offer', nextStep: { dueAt: THU_14 + DAY, kind: 'call' } });
  assert.deepEqual([v.stageKey, v.version, v.stageChangedAt], ['offer', 1, THU_14]);
  const tasks = await db.sql<{ source: string; kind: string; assigneeUserId: string; dueAt: number; sourceKey: string | null }>`SELECT * FROM tasks WHERE deal_id = 'dl-s1'`;
  assert.deepEqual(tasks.map((t) => [t.source, t.kind, t.assigneeUserId, t.dueAt, t.sourceKey]), [['manual', 'call', U.rop, THU_14 + DAY, null]]);
  const feed = await db.sql<{ kind: string; data: Record<string, unknown> }>`SELECT kind, data FROM client_events WHERE id = ${opId}`;
  assert.deepEqual(feed[0]?.data, { dealId: 'dl-s1', from: 'booked', to: 'offer', cause: 'manual' });
  // повтор opId — без второго события и задачи
  await moveDealStage(deps, rop, { dealId: 'dl-s1', opId, version: 0, stageKey: 'offer', nextStep: { dueAt: THU_14 + DAY, kind: 'call' } });
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE deal_id = 'dl-s1'`).length, 1);
  // шаг в прошлом (больше 5 минут) — 400
  await assert.rejects(move(rop, 'dl-s1', 'contract', 1, { dueAt: THU_14 - 10 * 60_000, kind: 'call' }));
});

test('открытая задача со сроком по сделке заменяет шаг', async () => {
  await seedDeal(db.sql, { id: 'dl-s2', client: 'cl-b-51', card: 'cd-b-51', stage: 'booked' });
  await db.sql`INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, created_at)
               VALUES ('tk-s2', 'sp-sales', 'cl-b-51', 'dl-s2', 'call', 'manual', '', ${THU_14 + DAY}, ${U.rop}, ${THU_14})`;
  const v = await move(rop, 'dl-s2', 'offer', 0);
  assert.equal(v.stageKey, 'offer');
});

test('требования этапа: поля сделки и явка — stage_fields_required со списком', async () => {
  await seedDeal(db.sql, { id: 'dl-s3', client: 'cl-b-52', card: 'cd-b-52', stage: 'booked' });
  await assert.rejects(move(rop, 'dl-s3', 'contract', 0), (e: unknown) => e instanceof DealDomainError && e.code === 'stage_fields_required' && e.fields?.join() === 'budget');
  await assert.rejects(move(rop, 'dl-s3', 'attended', 0), (e: unknown) => e instanceof DealDomainError && e.code === 'stage_fields_required' && e.fields?.join() === 'attendance');
  await db.sql`UPDATE deals SET custom = '{"budget": "до 1 млн"}'::jsonb WHERE id = 'dl-s3'`;
  assert.equal((await move(rop, 'dl-s3', 'contract', 0)).stageKey, 'contract');
});

test('назад: консультант в окне — 403, РОП — можно; «Покупка»/«Проигран» целью — 400; устаревшая версия — 409', async () => {
  await seedDeal(db.sql, { id: 'dl-s4', client: FX.bkInWindow.client, card: FX.bkInWindow.card, stage: 'offer' });
  await assert.rejects(move(cons, 'dl-s4', 'booked', 0), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(move(rop, 'dl-s4', 'paid', 0), failsWith('use_purchase'));
  await assert.rejects(move(rop, 'dl-s4', 'lost', 0), failsWith('use_lose'));
  await assert.rejects(move(rop, 'dl-s4', 'nope', 0), failsWith('stage_unknown'));
  await assert.rejects(move(rop, 'dl-s4', 'booked', 7), (e: unknown) => e instanceof ConflictError);
  const v = await move(rop, 'dl-s4', 'booked', 0);
  assert.equal(v.stageKey, 'booked');
  // консультант вперёд — можно (deal.edit по отношению)
  await db.sql`UPDATE deals SET custom = '{"budget": "x"}'::jsonb WHERE id = 'dl-s4'`;
  assert.equal((await move(cons, 'dl-s4', 'contract', v.version)).stageKey, 'contract');
});

test('доступ: оператор и директор — 404 на действие; чужое = несуществующее; закрытая — deal_closed', async () => {
  await seedDeal(db.sql, { id: 'dl-s5', client: 'cl-b-53', card: 'cd-b-53', stage: 'booked', owner: U.opB });
  await assert.rejects(move(opB, 'dl-s5', 'contract', 0), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(move(dir, 'dl-s5', 'contract', 0), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(move(rop, 'нет-такой', 'contract', 0), (e: unknown) => e instanceof NotFoundError);
  await db.sql`UPDATE deals SET status = 'won', won_at = 1 WHERE id = 'dl-s5'`;
  await assert.rejects(move(rop, 'dl-s5', 'offer', 0), failsWith('deal_closed'));
  await assert.rejects(loseDeal(deps, rop, { dealId: 'dl-s5', opId: uuid(), version: 0, reasonCode: 'no_time', reasonText: '' }), failsWith('deal_closed'));
});

test('проигрыш последней открытой при «Договорились»: мягкая → «Не интересует»', async () => {
  await seedDeal(db.sql, { id: 'dl-l1', client: 'cl-b-60', card: 'cd-b-60', stage: 'offer' });
  const opId = uuid();
  const v = await loseDeal(deps, rop, { dealId: 'dl-l1', opId, version: 0, reasonCode: 'no_time', reasonText: '' });
  assert.deepEqual([v.status, v.stageKey, v.lostReasonCode], ['lost', 'lost', 'no_time']);
  assert.equal(await cardState(db.sql, 'cd-b-60'), 'not_interested');
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE id = ${opId} AND kind = 'deal.lost'`).length, 1);
  // повтор — без изменений
  await loseDeal(deps, rop, { dealId: 'dl-l1', opId, version: 0, reasonCode: 'no_time', reasonText: '' });
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE deal_id = 'dl-l1' AND kind = 'deal.lost'`).length, 1);
});

test('проигрыш жёсткий → «Не целевой», будущие записи отменены; текст причины — в сделке, не в ленте', async () => {
  await seedDeal(db.sql, { id: 'dl-l2', client: 'cl-b-61', card: 'cd-b-61', stage: 'offer' });
  await seedEvent(db.sql, { id: 'ev-l2', date: '2026-11-05', time: '15:00' });
  const [bk] = await seedBookings(db.sql, 'ev-l2', [{ client: 'cl-b-61', card: 'cd-b-61' }]);
  await assert.rejects(loseDeal(deps, rop, { dealId: 'dl-l2', opId: uuid(), version: 0, reasonCode: 'other', reasonText: '  ' }), failsWith('reason_text_required'));
  await assert.rejects(loseDeal(deps, rop, { dealId: 'dl-l2', opId: uuid(), version: 0, reasonCode: 'nope', reasonText: '' }), failsWith('reason_unknown'));
  await loseDeal(deps, rop, { dealId: 'dl-l2', opId: uuid(), version: 0, reasonCode: 'other', reasonText: 'Ушли к конкуренту' });
  assert.equal(await cardState(db.sql, 'cd-b-61'), 'not_target');
  assert.equal((await dealRow(db.sql, 'dl-l2'))?.lostReasonText, 'Ушли к конкуренту');
  const b = await db.sql<{ status: string; cancelReason: string }>`SELECT status, cancel_reason FROM bookings WHERE id = ${bk!}`;
  assert.deepEqual([b[0]?.status, b[0]?.cancelReason], ['cancelled', 'not_target']);
  const feed = await db.sql<{ data: unknown }>`SELECT data FROM client_events WHERE client_id = 'cl-b-61'`;
  assert.ok(!JSON.stringify(feed).includes('конкурент'));
});

test('проигрыш одной из двух открытых → карточка остаётся «Договорились»; карточка не в «Договорились» не меняется', async () => {
  await seedDeal(db.sql, { id: 'dl-l3', client: 'cl-b-62', card: 'cd-b-62', stage: 'offer' });
  await seedDeal(db.sql, { id: 'dl-l3b', client: 'cl-b-62', card: 'cd-b-62', stage: 'booked' });
  await loseDeal(deps, rop, { dealId: 'dl-l3', opId: uuid(), version: 0, reasonCode: 'company_closed', reasonText: '' });
  assert.equal(await cardState(db.sql, 'cd-b-62'), 'agreed');
  await db.sql`UPDATE cards SET state = 'client' WHERE id = 'cd-b-62'`;
  await loseDeal(deps, rop, { dealId: 'dl-l3b', opId: uuid(), version: 0, reasonCode: 'no_time', reasonText: '' });
  assert.equal(await cardState(db.sql, 'cd-b-62'), 'client');
});

test('проигрыш жёсткий: отменённая запись к консультанту отдаёт место резерву, задача «Назначьте консультанта» закрыта', async () => {
  // Консультант на одно место: A — основная запись, B — резерв того же слота; у A ещё «серая» заявка с задачей РОП
  await addConsultant(db.sql, { id: 'c-l4', userId: U.marketer, capacity: 1 });
  await seedDeal(db.sql, { id: 'dl-l4', client: 'cl-b-63', card: 'cd-b-63', stage: 'offer' });
  await insertGrey(db.sql, { id: 'bk-l4-main', client: 'cl-b-63', card: 'cd-b-63', date: '2026-11-03', time: '11:00', resourceId: 'c-l4', createdAt: THU_14 - 2 * DAY });
  await insertGrey(db.sql, { id: 'bk-l4-res', client: 'cl-b-64', card: 'cd-b-64', date: '2026-11-03', time: '11:00', resourceId: 'c-l4', createdAt: THU_14 - DAY });
  await db.sql`UPDATE bookings SET is_reserve = TRUE WHERE id = 'bk-l4-res'`;
  await insertGrey(db.sql, { id: 'bk-l4-grey', client: 'cl-b-63', card: 'cd-b-63', date: '2026-11-04', time: '10:00' });
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, source_key, created_at)
    VALUES (${uuid()}, 'sp-sales', 'cl-b-63', 'check', 'grey_unassigned', '', 'grey_unassigned:bk-l4-grey', ${THU_14})`;

  await loseDeal(deps, rop, { dealId: 'dl-l4', opId: uuid(), version: 0, reasonCode: 'company_closed', reasonText: '' });
  assert.equal(await cardState(db.sql, 'cd-b-63'), 'not_target');
  const rows = await db.sql<{ id: string; status: string; isReserve: boolean }>`SELECT id, status, is_reserve FROM bookings WHERE id LIKE 'bk-l4-%' ORDER BY id`;
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.isReserve]), [
    ['bk-l4-grey', 'cancelled', false],
    ['bk-l4-main', 'cancelled', false],
    ['bk-l4-res', 'registered', false],
  ]);
  const promoted = await db.sql<{ meta: { resourceId: string } }>`SELECT meta FROM booking_history WHERE booking_id = 'bk-l4-res' AND action = 'promoted'`;
  assert.deepEqual(promoted.map((h) => h.meta.resourceId), ['c-l4']);
  const bells = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'reserve_promoted' AND entity_id = 'bk-l4-res'`;
  assert.deepEqual(bells.map((b) => b.userId).sort(), [U.marketer, U.opA].sort());
  const grey = await db.sql<{ status: string }>`SELECT status FROM tasks WHERE source_key = 'grey_unassigned:bk-l4-grey'`;
  assert.deepEqual(grey.map((t) => t.status), ['done']);
});
