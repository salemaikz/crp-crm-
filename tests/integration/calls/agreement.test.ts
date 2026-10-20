// «Договорились — записать» (docs/calls-design.md §4.3, D-019): итог, запись и сделка одной транзакцией.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import { getToday } from '../../../src/server/domain/calls/today';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { seedBookings, seedEvent } from '../booking/helpers';
import { MIN, SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };

const cnt = async (q: Promise<Array<{ n: number }>>): Promise<number> => (await q)[0]!.n;
const fresh = (id: string, over: Parameters<typeof setCard>[2] = {}) => setCard(db.sql, id, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null, ...over });
const agreedReq = (cardId: string, eventId: string) =>
  outcomeReq({ cardId, outcomeKey: 'agreed', agreement: { contactId: null, agreedDueAt: null, booking: { kind: 'group', eventId } } });

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ev-ag', date: '2026-10-30', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-one', date: '2026-10-30', time: '16:00', capacity: 1 });
});
after(() => closeCallsWorld(db));

test('итог + запись + сделка: одна транзакция, карточка в «Договорились», id записи в ответе', async () => {
  await fresh('cd-a-70');
  const req = agreedReq('cd-a-70', 'ev-ag');
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.equal(r.card?.state, 'agreed');
  assert.ok(r.bookingId);
  // мастер в шторке получает запись целиком: дату для тоста и версию для «Отменить»
  assert.equal(r.booking?.id, r.bookingId);
  assert.equal(r.bookingAction, 'created');
  assert.equal(r.booking?.status, 'registered');
  const b = await db.sql<{ id: string; requestId: string; status: string; dealId: string | null; cardId: string }>`SELECT id, request_id, status, deal_id, card_id FROM bookings WHERE client_id = 'cl-a-70'`;
  assert.equal(b.length, 1);
  assert.deepEqual([b[0]!.id, b[0]!.requestId, b[0]!.status, b[0]!.cardId], [r.bookingId, req.opId, 'registered', 'cd-a-70']);
  const deals = await db.sql<{ id: string; stageKey: string; status: string; requestId: string | null }>`SELECT id, stage_key, status, request_id FROM deals WHERE card_id = 'cd-a-70'`;
  assert.equal(deals.length, 1, 'ровно одна сделка: эффект ensure_open нашёл сделку записи');
  assert.deepEqual([deals[0]!.id, deals[0]!.stageKey, deals[0]!.status, deals[0]!.requestId], [b[0]!.dealId, 'booked', 'open', req.opId]);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${req.opId} AND applied = 'applied'`), 1);
});

test('повтор итога при переносе: автор записи — прежний, но итог мой — запись отдаётся (автор по calls.opId)', async () => {
  await fresh('cd-a-80');
  const req = agreedReq('cd-a-80', 'ev-ag');
  const first = await submitOutcome(deps, opA, req);
  // перенос чужой записи: у записи остаётся прежний автор, а итог (calls.opId) принадлежит тому, кто переносит
  await db.sql`UPDATE bookings SET booked_by_user_id = ${U.opB} WHERE id = ${first.bookingId!}`;
  const again = await submitOutcome(deps, opA, req);
  assert.equal(again.status, 'duplicate');
  assert.equal(again.booking?.id, first.bookingId);
  // чужой итог с тем же opId запись не раскрывает
  const other = await submitOutcome(deps, await viewerOf(U.opB), req).catch(() => null);
  assert.equal(other?.booking ?? null, null);
});

test('запись из шторки попадает в «Сегодня» оператора: итог, дозвон и запись', async () => {
  await fresh('cd-a-79');
  const t0 = await getToday(deps, opA);
  await submitOutcome(deps, opA, agreedReq('cd-a-79', 'ev-ag'));
  const t1 = await getToday(deps, opA);
  assert.deepEqual([t1.outcomes - t0.outcomes, t1.connected - t0.connected, t1.booked - t0.booked], [1, 1, 1]);
});

test('повтор того же opId после успеха: duplicate, второй записи и сделки нет', async () => {
  await fresh('cd-a-71');
  const req = agreedReq('cd-a-71', 'ev-ag');
  await submitOutcome(deps, opA, req);
  const first = await submitOutcome(deps, opA, req);
  const again = await submitOutcome(deps, opA, req);
  assert.equal(again.status, 'duplicate');
  // потерянный ответ: повтор отдаёт ту же запись, чтобы мастер закончил как после первого запроса
  assert.equal(again.bookingId, first.bookingId);
  assert.equal(again.booking?.id, first.bookingId);
  assert.equal(again.booking?.version, first.booking?.version);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-71'`), 1);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-a-71'`), 1);
});

test('последнее место занято: отказ записи откатывает всё — ни calls, ни записи, ни сделки, карточка прежняя', async () => {
  await fresh('cd-a-72');
  await seedBookings(db.sql, 'ev-one', [{ client: 'cl-a-73', card: 'cd-a-73' }], { bookedBy: U.opA });
  const req = agreedReq('cd-a-72', 'ev-one');
  await assert.rejects(submitOutcome(deps, opA, req), (e: unknown) => e instanceof BookingDomainError && e.code === 'event_full' && Array.isArray(e.alternatives));
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${req.opId}`), 0);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-72'`), 0);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-a-72'`), 0);
  const card = await cardOf(db.sql, 'cd-a-72');
  assert.deepEqual([card.state, card.version], ['new', 0]);
});

test('карточку передали после звонка: итог фактом, записи нет, bookingId = null', async () => {
  await fresh('cd-a-74', { owner: U.opB });
  await db.sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, day, created_at)
               VALUES ('al-ag-1', 'sp-sales', 'cd-a-74', NULL, ${U.opA}, 'manual', FALSE, '2026-10-27', ${SEED_NOW - 60 * MIN}),
                      ('al-ag-2', 'sp-sales', 'cd-a-74', ${U.opA}, ${U.opB}, 'transfer', FALSE, '2026-10-28', ${SEED_NOW - 20 * MIN})`;
  const r = await submitOutcome(deps, opA, { ...agreedReq('cd-a-74', 'ev-ag'), via: 'offline', occurredAt: SEED_NOW - 30 * MIN });
  assert.deepEqual([r.status, r.factReason, r.bookingId, r.card], ['fact_only', 'owner_changed', null, null]);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-74'`), 0);
});

test('договорённость с датой без записи: задача agreement:<opId> владельцу, сделка по настройкам', async () => {
  await fresh('cd-a-75');
  const req = outcomeReq({ cardId: 'cd-a-75', outcomeKey: 'agreed', agreement: { contactId: null, agreedDueAt: SEED_NOW + 24 * 60 * MIN, booking: null } });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.card?.state, 'agreed');
  assert.equal(r.bookingId, null);
  const t = await db.sql<{ sourceKey: string; assigneeUserId: string }>`SELECT source_key, assignee_user_id FROM tasks WHERE client_id = 'cl-a-75'`;
  assert.deepEqual(t.map((x) => [x.sourceKey, x.assigneeUserId]), [[`agreement:${req.opId}`, U.opA]]);
});
