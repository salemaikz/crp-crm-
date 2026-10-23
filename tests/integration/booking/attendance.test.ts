// Явка (B2, §5.3, §7.1): «пришёл» / «не пришёл», исправление, права РОП и дежурного, события карточки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { markAttendance } from '../../../src/server/domain/booking/bookings';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { DAY, MIN, SEED_NOW, closeWorld, enterSeedWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let duty: Viewer;
let opA: Viewer;
let opB: Viewer;
const port = fakeCardPort();
const clock = { now: SEED_NOW };

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const statusOf = async (id: string) => (await db.sql<{ status: string; version: number }>`SELECT status, version FROM bookings WHERE id = ${id}`)[0];

async function guest(event: string, n: number, over: { status?: 'registered' | 'confirmed' | 'attended' | 'no_show' } = {}): Promise<string> {
  const ids = await seedBookings(db.sql, event, [{ client: `cl-a-${n}`, card: `cd-a-${n}` }], { bookedBy: U.opA, ...over });
  return ids[0]!;
}

/** Открытая задача неявки записи — её создаёт машина карточки (№ 16, 28, 33 с неявкой). */
async function openNoShowTask(bookingId: string, clientId: string): Promise<void> {
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, source_key, status, created_at)
    VALUES (${uuid()}, 'sp-sales', ${clientId}, 'call', 'no_show', '', ${`no_show:${bookingId}`}, 'open', ${SEED_NOW})`;
}

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps(clock, port);
  rop = await viewerOf(U.rop);
  duty = await viewerOf(U.duty);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  await seedEvent(db.sql, { id: 'ev-am', date: '2026-10-28', time: '09:00' }); // идёт сейчас (11:00)
  await seedEvent(db.sql, { id: 'ev-pm', date: '2026-10-28', time: '15:00' }); // сегодня, ещё не началось
  await seedEvent(db.sql, { id: 'ev-next', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-old', date: '2026-10-26', time: '15:00' });
  for (const ev of ['ev-am', 'ev-pm', 'ev-next', 'ev-old']) await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES (${ev}, ${U.duty}, ${SEED_NOW})`;
});
after(() => closeWorld(db));

test('время: «пришёл» до суток мероприятия и «не пришёл» до начала — too_early', async () => {
  const tomorrow = await guest('ev-next', 1);
  await assert.rejects(markAttendance(deps, rop, { bookingId: tomorrow, opId: uuid(), version: 0, to: 'attended' }), failsWith('too_early'));
  const pm = await guest('ev-pm', 2);
  await assert.rejects(markAttendance(deps, rop, { bookingId: pm, opId: uuid(), version: 0, to: 'no_show' }), failsWith('too_early'));
  assert.equal((await statusOf(pm))?.status, 'registered');
  assert.equal(port.calls.length, 0);
});

test('дежурный в день мероприятия отмечает «пришёл»: событие attended с днём мероприятия и фактом о следующей записи', async () => {
  port.reset();
  const id = await guest('ev-pm', 3);
  const r = await markAttendance(deps, duty, { bookingId: id, opId: uuid(), version: 0, to: 'attended' });
  assert.equal(r.status, 'attended');
  assert.equal(port.calls.length, 1);
  const e = port.calls[0]!.event;
  assert.ok(e.type === 'attended' && e.eventDay === '2026-10-28' && e.facts.hasNextFutureBooking === false && e.bookingId === id);
  assert.equal(port.calls[0]!.result.status, 'applied');
});

test('дежурный на следующий день и оператор без дежурства — как несуществующая запись', async () => {
  const id = await guest('ev-am', 4);
  await assert.rejects(markAttendance(deps, opA, { bookingId: id, opId: uuid(), version: 0, to: 'attended' }), failsWith('booking_not_found'), 'оператор: явка — не его право');
  await assert.rejects(markAttendance(deps, opB, { bookingId: id, opId: uuid(), version: 0, to: 'attended' }), failsWith('booking_not_found'));
  // наступили следующие сутки: дежурство «сегодня» кончилось
  enterSeedWorld({ now: SEED_NOW + DAY });
  try {
    const nextDay = await viewerOf(U.duty);
    clock.now = SEED_NOW + DAY;
    await assert.rejects(markAttendance(deps, nextDay, { bookingId: id, opId: uuid(), version: 0, to: 'attended' }), failsWith('booking_not_found'));
  } finally {
    clock.now = SEED_NOW;
    enterSeedWorld();
  }
  assert.equal((await statusOf(id))?.status, 'registered');
});

test('«не пришёл» → событие no_show с фактом о других записях; повтор opId событие не дублирует', async () => {
  port.reset();
  const id = await guest('ev-am', 5);
  await guest('ev-next', 5); // у клиента есть ещё запись
  const opId = uuid();
  const r = await markAttendance(deps, rop, { bookingId: id, opId, version: 0, to: 'no_show' });
  assert.equal(r.status, 'no_show');
  assert.equal(port.calls.length, 1);
  const e = port.calls[0]!.event;
  assert.ok(e.type === 'no_show' && e.facts.hasOtherFutureBooking === true && e.opId === opId);
  const again = await markAttendance(deps, rop, { bookingId: id, opId, version: 0, to: 'no_show' });
  assert.equal(again.status, 'no_show');
  assert.equal(port.calls.length, 1);
});

test('исправление «не пришёл → пришёл» при карточке в перезвоне: attendance_corrected с временем отметки', async () => {
  port.reset();
  const id = await guest('ev-am', 6);
  clock.now = SEED_NOW;
  await markAttendance(deps, rop, { bookingId: id, opId: uuid(), version: 0, to: 'no_show' });
  assert.equal(port.calls[0]?.event.type, 'no_show');
  // карточку в «Перезвон» переводит машина обзвона (C5); здесь — имитация
  await setCardState(db.sql, 'cd-a-6', 'callback');
  await openNoShowTask(id, 'cl-a-6');
  port.reset();
  clock.now = SEED_NOW + 5 * MIN;
  const r = await markAttendance(deps, rop, { bookingId: id, opId: uuid(), version: 1, to: 'attended' });
  assert.equal(r.status, 'attended');
  const call = port.calls[0]!;
  assert.equal(call.state, 'callback');
  assert.ok(call.event.type === 'attendance_corrected' && call.event.noShowMarkedAt === SEED_NOW && call.event.facts.hasNextFutureBooking === false);
  assert.equal(call.result.status, 'applied');
  clock.now = SEED_NOW;
});

test('№ 31 после № 33 без неявки: задачи неявки нет — stale, карточка остаётся в перезвоне', async () => {
  port.reset();
  const id = await guest('ev-am', 95, { status: 'no_show' });
  await db.sql`INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at) VALUES (${uuid()}, ${id}, 'status', 'registered', 'no_show', ${U.rop}, '{}', ${SEED_NOW - 60_000})`;
  await setCardState(db.sql, 'cd-a-95', 'callback');
  const r = await markAttendance(deps, rop, { bookingId: id, opId: uuid(), version: 0, to: 'attended' });
  assert.equal(r.status, 'attended', 'явка исправлена');
  const res = port.calls[0]?.result;
  assert.deepEqual([port.calls[0]?.event.type, res?.status, res?.status === 'rejected' && res.error], ['attendance_corrected', 'rejected', 'stale']);
  const [c] = await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = 'cd-a-95'`;
  assert.equal(c?.state, 'callback');
});

test('исправление при карточке в «Договорились» — событие attended (как № 18); отказ ядра (stale) запись не откатывает', async () => {
  port.reset();
  const id = await guest('ev-am', 7, { status: 'no_show' });
  const r = await markAttendance(deps, rop, { bookingId: id, opId: uuid(), version: 0, to: 'attended' });
  assert.equal(r.status, 'attended');
  assert.equal(port.calls[0]?.event.type, 'attended');

  // карточка в перезвоне, но итог новее отметки «не пришёл» → ядро ответит stale
  const stale = await guest('ev-am', 8, { status: 'no_show' });
  await db.sql`INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at) VALUES (${uuid()}, ${stale}, 'status', 'registered', 'no_show', ${U.rop}, '{}', ${SEED_NOW - 3_600_000})`;
  await setCardState(db.sql, 'cd-a-8', 'callback');
  await openNoShowTask(stale, 'cl-a-8');
  await db.sql`UPDATE cards SET last_outcome_at = ${SEED_NOW - 60_000} WHERE id = 'cd-a-8'`;
  port.reset();
  const opId = uuid();
  const r2 = await markAttendance(deps, rop, { bookingId: stale, opId, version: 0, to: 'attended' });
  assert.equal(r2.status, 'attended', 'запись изменилась, хотя карточка отказала');
  assert.deepEqual([port.calls[0]?.result.status, port.calls[0]?.result.status === 'rejected' && port.calls[0].result.error], ['rejected', 'stale']);
  const [h] = await db.sql<{ meta: { card?: string } }>`SELECT meta FROM booking_history WHERE id = ${opId}`;
  assert.equal(h?.meta.card, 'stale');
});

test('«пришёл → не пришёл»: дежурный в тот же день — да; РОП через два дня — да (поздняя правка)', async () => {
  port.reset();
  const today = await guest('ev-am', 9, { status: 'attended' });
  const r = await markAttendance(deps, duty, { bookingId: today, opId: uuid(), version: 0, to: 'no_show' });
  assert.equal(r.status, 'no_show');
  assert.equal(port.calls[0]?.event.type, 'no_show');

  const old = await guest('ev-old', 10, { status: 'attended' });
  clock.now = SEED_NOW; // 28.10: мероприятие было 26.10 — больше суток назад
  const late = await markAttendance(deps, rop, { bookingId: old, opId: uuid(), version: 0, to: 'no_show' });
  assert.equal(late.status, 'no_show');
});

test('карточка в «Клиент»: события карточки нет, сделка двигается напрямую и только вперёд', async () => {
  port.reset();
  const t = SEED_NOW - DAY;
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
               VALUES ('dl-adv', 'sp-sales', 'sales', 'booked', 'open', 'cl-a-11', 'cd-a-11', ${U.opA}, ${t}, ${t}, ${t}),
                      ('dl-far', 'sp-sales', 'sales', 'offer', 'open', 'cl-a-12', 'cd-a-12', ${U.opA}, ${t}, ${t}, ${t})`;
  const a = await guest('ev-am', 11);
  const b = await guest('ev-am', 12);
  await db.sql`UPDATE bookings SET deal_id = 'dl-adv' WHERE id = ${a}`;
  await db.sql`UPDATE bookings SET deal_id = 'dl-far' WHERE id = ${b}`;
  await setCardState(db.sql, 'cd-a-11', 'client');
  await setCardState(db.sql, 'cd-a-12', 'client');
  await markAttendance(deps, rop, { bookingId: a, opId: uuid(), version: 0, to: 'attended' });
  await markAttendance(deps, rop, { bookingId: b, opId: uuid(), version: 0, to: 'attended' });
  assert.equal(port.calls.length, 0);
  const stages = await db.sql<{ id: string; stageKey: string }>`SELECT id, stage_key FROM deals WHERE id IN ('dl-adv', 'dl-far') ORDER BY id`;
  assert.deepEqual(stages.map((s) => [s.id, s.stageKey]), [['dl-adv', 'attended'], ['dl-far', 'offer']]);
  const feed = await db.sql<{ dealId: string }>`SELECT deal_id FROM client_events WHERE kind = 'deal.stage'`;
  assert.deepEqual(feed.map((f) => f.dealId), ['dl-adv']);
});

test('устаревшая версия и перепутанный opId', async () => {
  const id = await guest('ev-am', 13);
  await assert.rejects(markAttendance(deps, rop, { bookingId: id, opId: uuid(), version: 3, to: 'attended' }), (e: unknown) => (e as { code?: string }).code === 'conflict');
  const other = await guest('ev-am', 14);
  const opId = uuid();
  await markAttendance(deps, rop, { bookingId: other, opId, version: 0, to: 'attended' });
  await assert.rejects(markAttendance(deps, rop, { bookingId: id, opId, version: 0, to: 'attended' }), failsWith('request_reused'));
});
