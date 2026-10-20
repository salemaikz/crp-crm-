// Перенос записи (B2, §5.2): заслуга остаётся от исходной записи, сделка сохраняется, места двигаются,
// полное мероприятие и устаревшая версия ничего не меняют.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { createBooking, moveBooking } from '../../../src/server/domain/booking/bookings';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'e1', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'e2', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'e-full', date: '2026-11-12', time: '15:00', capacity: 1 });
  await seedBookings(db.sql, 'e-full', clientsOf('b', 90, 90));
});
after(() => closeWorld(db));

const req = (clientId: string, eventId: string, requestId = uuid()) => ({ kind: 'group' as const, requestId, clientId, eventId, contactId: null });
const taken = async (eventId: string) =>
  (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${eventId} AND status IN ('registered','confirmed','attended','no_show')`)[0]?.n;
const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;

test('РОП переносит запись оператора: заслуга оператора, сделка та же, места E1 −1 и E2 +1', async () => {
  const first = await createBooking(deps, opA, req('cl-a-11', 'e1'));
  assert.equal(await taken('e1'), 1);
  const requestId = uuid();
  const r = await moveBooking(deps, rop, { bookingId: first.booking.id, version: first.booking.version, requestId, eventId: 'e2' });
  assert.equal(r.action, 'moved');
  assert.ok(r.action === 'moved' && r.movedFromId === first.booking.id);
  assert.equal(r.replayed, false);
  assert.equal(r.booking.bookedByUserId, U.opA, 'заслуга остаётся у того, кто записал');
  assert.equal(r.booking.dealId, first.booking.dealId, 'сделка сохранена');
  assert.equal(r.booking.responsibleUserId, U.opA);
  assert.equal(r.booking.movedFromId, first.booking.id);
  assert.equal(await taken('e1'), 0);
  assert.equal(await taken('e2'), 1);

  const [old] = await db.sql<{ status: string; movedToId: string; version: number }>`SELECT status, moved_to_id, version FROM bookings WHERE id = ${first.booking.id}`;
  assert.deepEqual(old, { status: 'moved', movedToId: r.booking.id, version: first.booking.version + 1 });
  const hist = await db.sql<{ bookingId: string; action: string; toStatus: string; actorId: string }>`
    SELECT booking_id, action, to_status, actor_id FROM booking_history WHERE booking_id IN (${first.booking.id}, ${r.booking.id}) ORDER BY created_at, action`;
  assert.deepEqual(
    hist.map((h) => [h.bookingId === r.booking.id ? 'new' : 'old', h.action, h.toStatus, h.actorId]).sort(),
    [['new', 'created', 'registered', U.rop], ['old', 'created', 'registered', U.opA], ['old', 'moved', 'moved', U.rop]].sort(),
  );
  const feed = await db.sql<{ kind: string; data: Record<string, string> }>`SELECT kind, data FROM client_events WHERE client_id = 'cl-a-11' AND kind = 'booking.moved'`;
  assert.equal(feed.length, 1);
  assert.deepEqual(feed[0]?.data, { fromId: first.booking.id, toId: r.booking.id, fromEventId: 'e1', toEventId: 'e2' });

  // повтор того же ключа — тот же результат, ничего не двигается
  const again = await moveBooking(deps, rop, { bookingId: first.booking.id, version: first.booking.version, requestId, eventId: 'e2' });
  assert.equal(again.replayed, true);
  assert.equal(again.booking.id, r.booking.id);
  assert.equal(await taken('e2'), 1);
});

test('перенос на полное мероприятие: event_full, ничего не изменилось', async () => {
  const first = await createBooking(deps, opA, req('cl-a-12', 'e1'));
  await assert.rejects(
    moveBooking(deps, opA, { bookingId: first.booking.id, version: 0, requestId: uuid(), eventId: 'e-full' }),
    (e: unknown) => e instanceof BookingDomainError && e.code === 'event_full' && (e.alternatives ?? []).length > 0,
  );
  const [row] = await db.sql<{ status: string; movedToId: string | null }>`SELECT status, moved_to_id FROM bookings WHERE id = ${first.booking.id}`;
  assert.deepEqual(row, { status: 'registered', movedToId: null });
  assert.equal(await taken('e-full'), 1);
});

test('перенос на то же мероприятие — already_registered; на несуществующее — event_not_found', async () => {
  const first = await createBooking(deps, opA, req('cl-a-13', 'e1'));
  await assert.rejects(moveBooking(deps, opA, { bookingId: first.booking.id, version: 0, requestId: uuid(), eventId: 'e1' }), failsWith('already_registered'));
  await assert.rejects(moveBooking(deps, opA, { bookingId: first.booking.id, version: 0, requestId: uuid(), eventId: 'nope' }), failsWith('event_not_found'));
});

test('устаревшая версия — конфликт; чужая запись — как несуществующая', async () => {
  const first = await createBooking(deps, opA, req('cl-a-14', 'e1'));
  await assert.rejects(moveBooking(deps, opA, { bookingId: first.booking.id, version: 7, requestId: uuid(), eventId: 'e2' }), (e: unknown) => e instanceof ConflictError);
  await assert.rejects(moveBooking(deps, opB, { bookingId: first.booking.id, version: 0, requestId: uuid(), eventId: 'e2' }), failsWith('booking_not_found'));
  await assert.rejects(moveBooking(deps, opA, { bookingId: 'no-such-booking', version: 0, requestId: uuid(), eventId: 'e2' }), failsWith('booking_not_found'));
  const [row] = await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${first.booking.id}`;
  assert.equal(row?.status, 'registered');
});

test('«не пришёл» при карточке в перезвоне: перенос только через итог (outcome_required)', async () => {
  const first = await createBooking(deps, opA, req('cl-a-15', 'e1'));
  await db.sql`UPDATE bookings SET status = 'no_show', version = version + 1 WHERE id = ${first.booking.id}`;
  await setCardState(db.sql, 'cd-a-15', 'callback');
  await assert.rejects(moveBooking(deps, opA, { bookingId: first.booking.id, version: 1, requestId: uuid(), eventId: 'e2' }), failsWith('outcome_required'));
  // после итога «Договорились» карточка снова в agreed — перенос «не пришедшего» разрешён автоматом статусов
  await setCardState(db.sql, 'cd-a-15', 'agreed');
  const r = await moveBooking(deps, opA, { bookingId: first.booking.id, version: 1, requestId: uuid(), eventId: 'e2' });
  assert.equal(r.action, 'moved');
});

test('нельзя перенести отменённую или посетившую запись (invalid_transition)', async () => {
  const first = await createBooking(deps, opA, req('cl-a-16', 'e1'));
  await db.sql`UPDATE bookings SET status = 'attended', version = version + 1 WHERE id = ${first.booking.id}`;
  await assert.rejects(moveBooking(deps, opA, { bookingId: first.booking.id, version: 1, requestId: uuid(), eventId: 'e2' }), failsWith('invalid_transition'));
});
