// Порт явки № 33 и пересчёт кэша (B1, pipeline-v2 §4.1, §5.1): явка через порт не трогает карточку и не зовёт событие;
// ручная явка пересчитывает признаки и горячесть при любом состоянии карточки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError, httpFailure } from '../../../src/server/domain/booking/errors';
import { markAttendance } from '../../../src/server/domain/booking/bookings';
import { setAttendanceInTx } from '../../../src/server/domain/booking/attendancePort';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import { cardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { seedDeal } from '../deals/helpers';
import { U } from '../../isolation/harness/seed';
import { DAY, SEED_NOW, closeDutyWorld, fakeCardPort, makeDeps, openDutyWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let fakeDeps: BookingDeps;
let realDeps: BookingDeps;
let rop: Viewer;
let opA: Viewer;
let opB: Viewer;
const fake = fakeCardPort();
const clock = { now: SEED_NOW };

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const card = async (id: string) => (await db.sql<{ state: string; version: number; updatedAt: number; attendedGroupAt: number | null; heat: number }>`SELECT state, version, updated_at, attended_group_at, heat FROM cards WHERE id = ${id}`)[0]!;
const run = <T>(f: (tx: typeof db.sql) => Promise<T>): Promise<T> => db.tx(f);

/** Запись гостя на мероприятие с открытой сделкой этой карточки. */
async function guest(event: string, n: number, over: { status?: 'registered' | 'attended' | 'no_show'; deal?: boolean } = {}): Promise<string> {
  const [id] = await seedBookings(db.sql, event, [{ client: `cl-a-${n}`, card: `cd-a-${n}` }], { bookedBy: U.opA, ...(over.status ? { status: over.status } : {}) });
  if (over.deal !== false) {
    await seedDeal(db.sql, { id: `dl-port-${n}`, client: `cl-a-${n}`, card: `cd-a-${n}`, stage: 'booked', owner: U.opA });
    await db.sql`UPDATE bookings SET deal_id = ${`dl-port-${n}`} WHERE id = ${id!}`;
  }
  return id!;
}

before(async () => {
  db = await openDutyWorld();
  fakeDeps = makeDeps(clock, fake);
  realDeps = makeDeps(clock, cardBookingPort);
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  await seedEvent(db.sql, { id: 'ev-am', date: '2026-10-28', time: '09:00' });
  await seedEvent(db.sql, { id: 'ev-pm', date: '2026-10-28', time: '15:00' });
});
after(() => closeDutyWorld(db));

test('явка через порт: статус, история и лента с автором есть; карточка и событие карточки не затронуты', async () => {
  fake.reset();
  const id = await guest('ev-am', 20);
  const before = await card('cd-a-20');
  const opId = uuid();
  const r = await run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: id, to: 'attended', opId, cardId: 'cd-a-20' }));
  assert.deepEqual([r.changed, r.status, r.eventKind], [true, 'attended', 'group']);
  assert.equal(typeof r.startedAt, 'number');
  assert.equal(fake.calls.length, 0, 'событие карточки не вызывается');
  const after = await card('cd-a-20');
  assert.deepEqual([after.state, after.version, after.updatedAt], [before.state, before.version, before.updatedAt]);
  const h = await db.sql<{ actorId: string }>`SELECT actor_id FROM booking_history WHERE id = ${opId}`;
  assert.equal(h[0]?.actorId, U.rop);
  const feed = await db.sql<{ actorId: string }>`SELECT actor_id FROM client_events WHERE ref_id = ${id} AND kind = 'booking.status'`;
  assert.equal(feed[0]?.actorId, U.rop);
});

test('порт: тот же статус — changed=false; другой конечный — 409 attendance_changed; повтор opId — changed=false', async () => {
  const id = await guest('ev-am', 21);
  const opId = uuid();
  await run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: id, to: 'no_show', opId }));
  const same = await run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: id, to: 'no_show', opId: uuid() }));
  assert.deepEqual([same.changed, same.status], [false, 'no_show']);
  const replay = await run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: id, to: 'no_show', opId }));
  assert.equal(replay.changed, false);
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: id, to: 'attended', opId: uuid() })), failsWith('attendance_changed'));
  const err = new BookingDomainError('attendance_changed');
  assert.deepEqual(httpFailure(err), { kind: 'response', status: 409, body: { error: 'conflict', detail: 'attendance_changed' } });
});

test('порт: «не пришёл» до начала — too_early; запись не из открытой сделки или чужой карточки — 404; без права отметки — 403', async () => {
  const early = await guest('ev-pm', 22);
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: early, to: 'no_show', opId: uuid() })), failsWith('too_early'));

  const noDeal = await guest('ev-am', 23, { deal: false });
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: noDeal, to: 'attended', opId: uuid() })), failsWith('booking_not_found'));

  const closed = await guest('ev-am', 24);
  await db.sql`UPDATE deals SET status = 'lost', lost_at = 1 WHERE id = 'dl-port-24'`;
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: closed, to: 'attended', opId: uuid() })), failsWith('booking_not_found'));

  const other = await guest('ev-am', 25);
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: other, to: 'attended', opId: uuid(), cardId: 'cd-a-1' })), failsWith('booking_not_found'));
  // чужой оператор не видит запись вовсе: тот же ответ, что на несуществующую
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, opB, { bookingId: other, to: 'attended', opId: uuid() })), failsWith('booking_not_found'));
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, rop, { bookingId: 'bk-нет', to: 'attended', opId: uuid() })), failsWith('booking_not_found'));
  // оператор видит свою запись, но отмечать явку не вправе
  await assert.rejects(run((tx) => setAttendanceInTx(fakeDeps, tx, opA, { bookingId: other, to: 'attended', opId: uuid() })), failsWith('attendance_forbidden'));
  assert.equal((await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${other}`)[0]?.status, 'registered');
});

test('явка при карточке «Клиент»: обновляет attended_group_at и горячесть, версию карточки не трогает', async () => {
  const id = await guest('ev-am', 26);
  await setCardState(db.sql, 'cd-a-26', 'client');
  const b = await card('cd-a-26');
  assert.equal(b.attendedGroupAt, null);
  await markAttendance(realDeps, rop, { bookingId: id, opId: uuid(), version: 0, to: 'attended' });
  const a = await card('cd-a-26');
  const startsAt = (await db.sql<{ startsAt: number }>`SELECT starts_at FROM bookings WHERE id = ${id}`)[0]!.startsAt;
  assert.equal(Number(a.attendedGroupAt), startsAt);
  assert.equal(a.state, 'client');
  assert.deepEqual([a.version, a.updatedAt], [b.version, b.updatedAt]);
  // и обратно: исправление на «не пришёл» снимает признак явки
  await markAttendance(realDeps, rop, { bookingId: id, opId: uuid(), version: 1, to: 'no_show' });
  const c = await card('cd-a-26');
  assert.equal(c.attendedGroupAt, null);
});

test('порт пересчитывает кэш в своей транзакции (карточка в «Договорились» остаётся неизменной)', async () => {
  const id = await guest('ev-am', 27);
  await run((tx) => setAttendanceInTx(realDeps, tx, rop, { bookingId: id, to: 'attended', opId: uuid() }));
  const a = await card('cd-a-27');
  assert.ok(a.attendedGroupAt !== null);
  assert.equal(a.state, 'agreed');
  void DAY;
});
