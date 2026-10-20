// Подтверждение и отмена записи (B2, §5.3, §7.1): место освобождается, порт получает booking_cancelled
// с фактом о других записях, «ошибка оператора» — автор и 10 минут, повтор opId безопасен.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { cancelBooking, createBooking, setConfirmation } from '../../../src/server/domain/booking/bookings';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { MIN, SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;
const port = fakeCardPort();
const clock = { now: SEED_NOW };

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps(clock, port);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'e1', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'e2', date: '2026-11-05', time: '15:00' });
});
after(() => closeWorld(db));

const req = (clientId: string, eventId: string) => ({ kind: 'group' as const, requestId: uuid(), clientId, eventId, contactId: null });
const taken = async (eventId: string) =>
  (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${eventId} AND status IN ('registered','confirmed','attended','no_show')`)[0]?.n;
const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;

test('отмена клиентом: место свободно, порт получил booking_cancelled без других записей, история и лента', async () => {
  clock.now = SEED_NOW;
  port.reset();
  const b = (await createBooking(deps, opA, req('cl-a-21', 'e1'))).booking;
  assert.equal(await taken('e1'), 1);
  const opId = uuid();
  const r = await cancelBooking(deps, opA, { bookingId: b.id, opId, version: b.version, reason: 'client' });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.cancelReason, 'client');
  assert.equal(r.version, 1);
  assert.equal(await taken('e1'), 0, 'место освобождено');

  assert.equal(port.calls.length, 1);
  const call = port.calls[0]!;
  assert.equal(call.state, 'agreed');
  assert.equal(call.event.type, 'booking_cancelled');
  assert.deepEqual(call.event.type === 'booking_cancelled' && { reason: call.event.reason, opId: call.event.opId, bookingId: call.event.bookingId, facts: call.event.facts, by: call.event.createdByOpId }, {
    reason: 'client',
    opId,
    bookingId: b.id,
    facts: { hasOtherFutureBooking: false },
    by: (await db.sql<{ requestId: string }>`SELECT request_id FROM bookings WHERE id = ${b.id}`)[0]?.requestId,
  });
  assert.equal(call.result.status, 'applied');

  const hist = await db.sql<{ id: string; action: string; fromStatus: string; toStatus: string; meta: Record<string, string> }>`SELECT * FROM booking_history WHERE id = ${opId}`;
  assert.deepEqual(hist.map((h) => [h.action, h.fromStatus, h.toStatus, h.meta.reason]), [['cancelled', 'registered', 'cancelled', 'client']]);
  const feed = await db.sql<{ data: Record<string, string> }>`SELECT data FROM client_events WHERE ref_id = ${b.id} AND kind = 'booking.status'`;
  assert.deepEqual(feed.map((f) => [f.data.from, f.data.to, f.data.reason]), [['registered', 'cancelled', 'client']]);
});

test('повтор того же opId — текущая запись, без второго события карточки; чужой opId — request_reused', async () => {
  port.reset();
  const b = (await createBooking(deps, opA, req('cl-a-22', 'e1'))).booking;
  const opId = uuid();
  await cancelBooking(deps, opA, { bookingId: b.id, opId, version: 0, reason: 'client' });
  const again = await cancelBooking(deps, opA, { bookingId: b.id, opId, version: 0, reason: 'client' });
  assert.equal(again.status, 'cancelled');
  assert.equal(port.calls.length, 1);
  const other = (await createBooking(deps, opA, req('cl-a-23', 'e1'))).booking;
  await assert.rejects(cancelBooking(deps, opA, { bookingId: other.id, opId, version: 0, reason: 'client' }), failsWith('request_reused'));
});

test('у клиента есть другая будущая запись — факт hasOtherFutureBooking = true', async () => {
  port.reset();
  const b = (await createBooking(deps, opA, req('cl-a-24', 'e1'))).booking;
  await seedBookings(db.sql, 'e2', [{ client: 'cl-a-24', card: 'cd-a-24' }]);
  await cancelBooking(deps, opA, { bookingId: b.id, opId: uuid(), version: 0, reason: 'client' });
  const e = port.calls[0]?.event;
  assert.ok(e && e.type === 'booking_cancelled' && e.facts.hasOtherFutureBooking === true);
});

test('карточка не в «Договорились»: запись отменяется без события карточки', async () => {
  port.reset();
  const b = (await createBooking(deps, opA, req('cl-a-25', 'e1'))).booking;
  await setCardState(db.sql, 'cd-a-25', 'client');
  const r = await cancelBooking(deps, opA, { bookingId: b.id, opId: uuid(), version: 0, reason: 'client' });
  assert.equal(r.status, 'cancelled');
  assert.equal(port.calls.length, 0);
});

test('ошибка оператора: автор в первые 10 минут — да; позже или не автор — too_late', async () => {
  port.reset();
  clock.now = SEED_NOW;
  const early = (await createBooking(deps, opA, req('cl-a-26', 'e1'))).booking;
  const late = (await createBooking(deps, opA, req('cl-a-27', 'e1'))).booking;
  const byRop = (await createBooking(deps, rop, req('cl-a-28', 'e1'))).booking;

  clock.now = SEED_NOW + 9 * MIN;
  const ok = await cancelBooking(deps, opA, { bookingId: early.id, opId: uuid(), version: 0, reason: 'operator_error' });
  assert.equal(ok.cancelReason, 'operator_error');
  const ev = port.calls[0]!.event;
  assert.ok(ev.type === 'booking_cancelled' && ev.reason === 'operator_error' && ev.createdByOpId !== null);

  clock.now = SEED_NOW + 11 * MIN;
  await assert.rejects(cancelBooking(deps, opA, { bookingId: late.id, opId: uuid(), version: 0, reason: 'operator_error' }), failsWith('too_late'));
  clock.now = SEED_NOW + 5 * MIN;
  await assert.rejects(cancelBooking(deps, rop, { bookingId: early.id, opId: uuid(), version: 1, reason: 'operator_error' }), failsWith('same_status'), 'уже отменена');
  await assert.rejects(cancelBooking(deps, opA, { bookingId: byRop.id, opId: uuid(), version: 0, reason: 'operator_error' }), failsWith('too_late'), 'записал РОП, не автор');
  // обычная отмена не ограничена по времени
  clock.now = SEED_NOW + 11 * MIN;
  assert.equal((await cancelBooking(deps, opA, { bookingId: late.id, opId: uuid(), version: 0, reason: 'client' })).status, 'cancelled');
  clock.now = SEED_NOW;
});

test('отмена: устаревшая версия — конфликт, чужая запись — как несуществующая, роль без booking.create — тоже', async () => {
  const b = (await createBooking(deps, opA, req('cl-a-29', 'e1'))).booking;
  await assert.rejects(cancelBooking(deps, opA, { bookingId: b.id, opId: uuid(), version: 5, reason: 'client' }), (e: unknown) => e instanceof ConflictError);
  await assert.rejects(cancelBooking(deps, opB, { bookingId: b.id, opId: uuid(), version: 0, reason: 'client' }), failsWith('booking_not_found'));
  const consultant = await viewerOf(U.consultant);
  await assert.rejects(cancelBooking(deps, consultant, { bookingId: b.id, opId: uuid(), version: 0, reason: 'client' }), (e: unknown) => e instanceof NotFoundError);
  const [row] = await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${b.id}`;
  assert.equal(row?.status, 'registered');
});

test('подтверждение и снятие подтверждения: события карточки нет; повторное — same_status', async () => {
  port.reset();
  const b = (await createBooking(deps, opA, req('cl-a-30', 'e1'))).booking;
  const c = await setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 0, to: 'confirmed' });
  assert.equal(c.status, 'confirmed');
  assert.equal(c.version, 1);
  await assert.rejects(setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 1, to: 'confirmed' }), failsWith('same_status'));
  const back = await setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 1, to: 'registered' });
  assert.equal(back.status, 'registered');
  assert.equal(port.calls.length, 0);
});

test('«передумал»: из отменённой записи подтвердить/вернуть нельзя — только новая запись тем же путём', async () => {
  const b = (await createBooking(deps, opA, req('cl-a-31', 'e1'))).booking;
  await cancelBooking(deps, opA, { bookingId: b.id, opId: uuid(), version: 0, reason: 'client' });
  await assert.rejects(setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 1, to: 'registered' }), failsWith('invalid_transition'));
  await assert.rejects(setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 1, to: 'confirmed' }), failsWith('invalid_transition'));
  const again = await createBooking(deps, opA, req('cl-a-31', 'e1'));
  assert.equal(again.action, 'created');
  assert.notEqual(again.booking.id, b.id);
});

test('подтвердить встречу, которая уже закончилась, нельзя (too_late)', async () => {
  const b = (await createBooking(deps, opA, req('cl-a-32', 'e1'))).booking;
  clock.now = Date.UTC(2026, 9, 29, 12, 0) + 4 * 60 * MIN; // после 18:00 местного
  await assert.rejects(setConfirmation(deps, opA, { bookingId: b.id, opId: uuid(), version: 0, to: 'confirmed' }), failsWith('too_late'));
  clock.now = SEED_NOW;
});
