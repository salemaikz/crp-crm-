// Сделки в объёме записи (B2, §7.3, D-134): ensureOpen идемпотентен, воронка manual сделку не создаёт,
// «пришёл» двигает только вперёд, эффекты ядра ensure_open / advance / set_needs_rebook / lose_created_by.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { systemActor } from '../../../src/server/access/systemActor';
import { applyDealEffects, createDealLink } from '../../../src/server/domain/deals/effects';
import { bookingPipeline, toDealStages, type PipelineInfo } from '../../../src/server/domain/deals/pipelines';
import type { DealStages, LockedCard } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { PIPELINES, SEED_NOW, closeWorld, openBookingWorld, seedBookings, seedEvent, uuid } from '../booking/helpers';

let db: TestDb;
const actor = systemActor('test-deals', SEED_NOW);
const link = createDealLink(async () => PIPELINES);
const STAGES: DealStages = toDealStages(bookingPipeline(PIPELINES)!);

const lockedCard = (n: number): LockedCard => ({
  id: `cd-a-${n}`,
  clientId: `cl-a-${n}`,
  spaceId: SPACE,
  state: 'agreed',
  ownerUserId: U.opA,
  actingUserId: null,
  lastOutcomeAt: null,
  version: 0,
});
const dealRows = (n: number) => db.sql<{ id: string; stageKey: string; status: string; requestId: string | null; lostReasonCode: string; needsRebook: boolean; ownerUserId: string | null; createdBy: string | null }>`
  SELECT * FROM deals WHERE card_id = ${`cd-a-${n}`} ORDER BY created_at, id`;

before(async () => {
  db = await openBookingWorld();
  await db.sql`DELETE FROM deals WHERE id IN ('dl-a-1', 'dl-b-1')`; // у карточек 1 свои сделки синтетики: мешают подсчёту
  await seedEvent(db.sql, { id: 'dv-1', date: '2026-10-29', time: '15:00' });
});
after(() => closeWorld(db));

test('воронка не создаёт сделку при записи (manual) → ensureOpen возвращает null', async () => {
  const manual: PipelineInfo[] = [{ key: 'sales', createDealOn: 'manual', stages: PIPELINES[0]!.stages }];
  assert.equal(bookingPipeline(manual), null);
  assert.equal(await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(1), { requestId: uuid(), at: SEED_NOW, stages: null })), null);
  assert.equal((await dealRows(1)).length, 0);
});

test('ensureOpen: создаёт на этапе on_agreed, повтор ключа и вторая запись берут ту же открытую сделку', async () => {
  const requestId = uuid();
  const id = await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(2), { requestId, at: SEED_NOW, stages: STAGES }));
  assert.ok(id);
  const again = await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(2), { requestId, at: SEED_NOW, stages: STAGES }));
  const other = await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(2), { requestId: uuid(), at: SEED_NOW, stages: STAGES }));
  assert.equal(again, id);
  assert.equal(other, id, 'у клиента уже есть открытая сделка воронки — второй не создаём');
  const rows = await dealRows(2);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]?.stageKey, rows[0]?.status, rows[0]?.requestId, rows[0]?.ownerUserId, rows[0]?.createdBy], ['booked', 'open', requestId, U.opA, null]);
  const feed = await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE deal_id = ${id}`;
  assert.deepEqual(feed.map((f) => f.kind), ['deal.created']);
});

test('закрытая сделка не мешает: после проигрыша запись создаёт новую', async () => {
  const first = (await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(3), { requestId: uuid(), at: SEED_NOW, stages: STAGES })))!;
  await db.sql`UPDATE deals SET status = 'lost', lost_at = ${SEED_NOW}, stage_key = 'lost' WHERE id = ${first}`;
  const second = await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(3), { requestId: uuid(), at: SEED_NOW, stages: STAGES }));
  assert.ok(second && second !== first);
});

test('advanceOnAttended: только вперёд; без этапа on_attended — ничего', async () => {
  const id = (await db.tx((tx) => link.ensureOpen(tx, actor, lockedCard(4), { requestId: uuid(), at: SEED_NOW, stages: STAGES })))!;
  await db.tx((tx) => link.advanceOnAttended(tx, actor, { dealId: id, bookingId: 'bk', at: SEED_NOW, stages: { ...STAGES, onAttendedStageKey: null } }));
  assert.equal((await dealRows(4))[0]?.stageKey, 'booked');
  await db.tx((tx) => link.advanceOnAttended(tx, actor, { dealId: id, bookingId: 'bk', at: SEED_NOW, stages: STAGES }));
  assert.equal((await dealRows(4))[0]?.stageKey, 'attended');
  await db.sql`UPDATE deals SET stage_key = 'offer' WHERE id = ${id}`;
  await db.tx((tx) => link.advanceOnAttended(tx, actor, { dealId: id, bookingId: 'bk', at: SEED_NOW, stages: STAGES }));
  assert.equal((await dealRows(4))[0]?.stageKey, 'offer', 'сделка, ушедшая дальше, назад не возвращается');
  await db.sql`UPDATE deals SET status = 'lost', lost_at = ${SEED_NOW}, stage_key = 'booked' WHERE id = ${id}`;
  await db.tx((tx) => link.advanceOnAttended(tx, actor, { dealId: id, bookingId: 'bk', at: SEED_NOW, stages: STAGES }));
  assert.equal((await dealRows(4))[0]?.stageKey, 'booked', 'закрытую сделку не двигаем');
});

test('applyDealEffects: ensure_open, advance по записи, set_needs_rebook, lose_created_by', async () => {
  const resolve = async () => PIPELINES;
  const card = lockedCard(5);
  const opId = uuid();
  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'ensure_open', stage: 'on_agreed', requestId: opId }], SEED_NOW, { resolve }));
  const [deal] = await dealRows(5);
  assert.equal(deal?.requestId, opId);
  // повтор эффекта (повтор итога) ничего не задваивает
  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'ensure_open', stage: 'on_agreed', requestId: opId }], SEED_NOW, { resolve }));
  assert.equal((await dealRows(5)).length, 1);

  const [bookingId] = await seedBookings(db.sql, 'dv-1', [{ client: 'cl-a-5', card: 'cd-a-5' }]);
  await db.sql`UPDATE bookings SET deal_id = ${deal!.id} WHERE id = ${bookingId!}`;
  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'set_needs_rebook', bookingId: bookingId!, value: true }, { op: 'advance', stage: 'on_attended', bookingId: bookingId! }], SEED_NOW, { resolve }));
  const after = (await dealRows(5))[0];
  assert.deepEqual([after?.needsRebook, after?.stageKey], [true, 'attended']);
  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'set_needs_rebook', bookingId: bookingId!, value: false }], SEED_NOW, { resolve }));
  assert.equal((await dealRows(5))[0]?.needsRebook, false);

  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'lose_created_by', opId, reasonCode: 'input_error' }], SEED_NOW + 1, { resolve }));
  const lost = (await dealRows(5))[0];
  assert.deepEqual([lost?.status, lost?.stageKey, lost?.lostReasonCode], ['lost', 'lost', 'input_error']);
  // сделку другого итога lose_created_by не трогает; уже закрытую — тоже
  await db.tx((tx) => applyDealEffects(tx, actor, card, [{ op: 'lose_created_by', opId, reasonCode: 'input_error' }, { op: 'lose_created_by', opId: uuid(), reasonCode: 'input_error' }], SEED_NOW + 2, { resolve }));
  assert.equal((await dealRows(5)).length, 1);
});

test('ensure_open при воронке manual сделку не создаёт; операции покупки — B6', async () => {
  const resolve = async (): Promise<PipelineInfo[]> => [{ key: 'sales', createDealOn: 'manual', stages: PIPELINES[0]!.stages }];
  await db.tx((tx) => applyDealEffects(tx, actor, lockedCard(6), [{ op: 'ensure_open', stage: 'on_agreed', requestId: uuid() }], SEED_NOW, { resolve }));
  assert.equal((await dealRows(6)).length, 0);
  await assert.rejects(
    db.tx((tx) => applyDealEffects(tx, actor, lockedCard(6), [{ op: 'win', dealId: null, serviceTypeKey: 'x', amountKzt: 1, requestId: uuid() }], SEED_NOW, { resolve })),
    /B6/,
  );
});
