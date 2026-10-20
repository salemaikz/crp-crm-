// Запись на групповое мероприятие (B2, §5.1): строка, история, лента, сделка, заслуга и ответственный,
// повтор ключа, состояния карточки, мероприятия-исключения, контакт, роли и охват.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, BadRequestError } from '../../../src/server/access';
import { systemActor } from '../../../src/server/access/systemActor';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf, DAY } from './helpers';

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
  await seedEvent(db.sql, { id: 'ev-1', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-2', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-past', date: '2026-10-26', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-cancelled', date: '2026-11-12', time: '15:00', status: 'cancelled' });
  await seedEvent(db.sql, { id: 'ev-other-type', date: '2026-11-12', time: '16:00', type: 'unknown_type' });
  await seedEvent(db.sql, { id: 'ev-full', date: '2026-11-19', time: '15:00', capacity: 2 });
  await seedBookings(db.sql, 'ev-full', clientsOf('b', 80, 81));
});
after(() => closeWorld(db));

const req = (clientId: string, eventId: string, over: { requestId?: string; contactId?: string | null } = {}) =>
  ({ kind: 'group' as const, requestId: over.requestId ?? uuid(), clientId, eventId, contactId: over.contactId ?? null });

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;

test('запись клиента в «Договорились»: строка, история, лента, сделка, заслуга и ответственный', async () => {
  const requestId = uuid();
  const r = await createBooking(deps, opA, req('cl-a-11', 'ev-1', { requestId }));
  assert.equal(r.action, 'created');
  assert.equal(r.replayed, false);
  const b = r.booking;
  assert.equal(b.status, 'registered');
  assert.equal(b.kind, 'group');
  assert.equal(b.eventId, 'ev-1');
  assert.equal(b.bookingDate, '2026-10-29');
  assert.equal(b.startTime, '15:00');
  assert.equal(b.bookedByUserId, U.opA, 'заслуга — оператор, который записал');
  assert.equal(b.responsibleUserId, U.opA, 'ответственный — владелец карточки');
  assert.equal(b.version, 0);
  assert.equal(b.via, 'ui');

  const [deal] = await db.sql<{ id: string; stageKey: string; status: string; requestId: string; cardId: string }>`SELECT * FROM deals WHERE request_id = ${requestId}`;
  assert.ok(deal, 'сделка создана');
  assert.equal(deal.stageKey, 'booked');
  assert.equal(deal.status, 'open');
  assert.equal(deal.cardId, 'cd-a-11');
  assert.equal(b.dealId, deal.id);

  const hist = await db.sql<{ action: string; toStatus: string; actorId: string }>`SELECT * FROM booking_history WHERE booking_id = ${b.id}`;
  assert.deepEqual(hist.map((h) => [h.action, h.toStatus, h.actorId]), [['created', 'registered', U.opA]]);
  const feed = await db.sql<{ kind: string; refId: string }>`SELECT kind, ref_id FROM client_events WHERE client_id = 'cl-a-11' AND kind LIKE 'booking.%'`;
  assert.deepEqual(feed.map((f) => [f.kind, f.refId]), [['booking.created', b.id]]);
  assert.equal(port.calls.length, 0, 'событий карточки при записи нет');
  const deals = await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE client_id = 'cl-a-11' AND kind LIKE 'deal.%'`;
  assert.deepEqual(deals.map((d) => d.kind), ['deal.created']);
});

test('у клиента уже есть открытая сделка воронки — запись берёт её, второй не создаёт', async () => {
  const r = await createBooking(deps, opA, req('cl-a-1', 'ev-1'));
  assert.equal(r.booking.dealId, 'dl-a-1');
  const n = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-a-1'`)[0]?.n;
  assert.equal(n, 1);
});

test('повтор того же ключа — прежний результат, одна строка; тот же ключ на другое мероприятие — request_reused', async () => {
  const requestId = uuid();
  const first = await createBooking(deps, opA, req('cl-a-2', 'ev-1', { requestId }));
  const again = await createBooking(deps, opA, req('cl-a-2', 'ev-1', { requestId }));
  assert.equal(again.replayed, true);
  assert.equal(again.booking.id, first.booking.id);
  const n = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE request_id = ${requestId}`)[0]?.n;
  assert.equal(n, 1);
  const d = (await db.sql<{ d: number }>`SELECT count(*)::int AS d FROM deals WHERE request_id = ${requestId}`)[0]?.d;
  assert.equal(d, 1, 'сделка одна');
  await assert.rejects(createBooking(deps, opA, req('cl-a-2', 'ev-2', { requestId })), failsWith('request_reused'));
});

test('карточка не в «Договорились»/«Клиент» → outcome_required; итог «Договорились» (fromOutcome) проходит из перезвона', async () => {
  await setCardState(db.sql, 'cd-a-3', 'callback');
  await assert.rejects(createBooking(deps, opA, req('cl-a-3', 'ev-1')), failsWith('outcome_required'));
  const opId = uuid();
  const r = await db.tx((tx) => createBooking(deps, opA, req('cl-a-3', 'ev-1', { requestId: opId }), { tx, fromOutcome: { opId } }));
  assert.equal(r.action, 'created');
  assert.equal(r.booking.status, 'registered');
  await setCardState(db.sql, 'cd-a-3', 'agreed');
  await setCardState(db.sql, 'cd-a-4', 'client');
  assert.equal((await createBooking(deps, opA, req('cl-a-4', 'ev-1'))).action, 'created', 'повторная продажа (client) допустима');
});

test('прошедшее, отменённое, полное мероприятие и чужой вид — коды; event_full несёт альтернативы', async () => {
  await assert.rejects(createBooking(deps, opA, req('cl-a-5', 'ev-past')), failsWith('event_in_past'));
  await assert.rejects(createBooking(deps, opA, req('cl-a-5', 'ev-cancelled')), failsWith('event_cancelled'));
  await assert.rejects(createBooking(deps, opA, req('cl-a-5', 'ev-other-type')), failsWith('invalid_settings'));
  await assert.rejects(createBooking(deps, opA, req('cl-a-5', 'no-such-event')), failsWith('event_not_found'));
  await assert.rejects(createBooking(deps, opA, req('cl-a-5', 'ev-full')), (e: unknown) => {
    assert.ok(e instanceof BookingDomainError && e.code === 'event_full');
    const alt = (e as BookingDomainError).alternatives ?? [];
    assert.ok(alt.length > 0 && alt.every((o) => o.seats.left > 0 && o.id !== 'ev-full'), 'только мероприятия с местами');
    return true;
  });
  const n = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-5'`)[0]?.n;
  assert.equal(n, 0, 'ни одной записи');
});

test('повторная запись на тот же вид — перенос, на то же мероприятие — already_registered', async () => {
  const first = await createBooking(deps, opA, req('cl-a-6', 'ev-1'));
  await assert.rejects(createBooking(deps, opA, req('cl-a-6', 'ev-1')), failsWith('already_registered'));
  const moved = await createBooking(deps, opA, req('cl-a-6', 'ev-2'));
  assert.equal(moved.action, 'moved');
  assert.ok(moved.action === 'moved' && moved.movedFromId === first.booking.id);
});

test('контакт чужого клиента → 400; контакт клиента принимается', async () => {
  const t = SEED_NOW - DAY;
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-a7', 'cl-a-7', 'Контакт Синтетик', ${t}), ('ct-a8', 'cl-a-8', 'Чужой Синтетик', ${t})`;
  await assert.rejects(createBooking(deps, opA, req('cl-a-7', 'ev-1', { contactId: 'ct-a8' })), (e: unknown) => e instanceof BadRequestError);
  const ok = await createBooking(deps, opA, req('cl-a-7', 'ev-1', { contactId: 'ct-a7' }));
  assert.equal(ok.booking.contactId, 'ct-a7');
});

test('чужой клиент и роль без booking.create → как несуществующий (NotFoundError)', async () => {
  await assert.rejects(createBooking(deps, opA, req('cl-b-1', 'ev-1')), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(createBooking(deps, opA, req('cl-nonexistent', 'ev-1')), (e: unknown) => e instanceof NotFoundError);
  const consultant = await viewerOf(U.consultant);
  await assert.rejects(createBooking(deps, consultant, req('cl-b-2', 'ev-1')), (e: unknown) => e instanceof NotFoundError, 'консультант по отношению групповые записи не трогает');
  const director = await viewerOf(U.director);
  await assert.rejects(createBooking(deps, director, req('cl-b-2', 'ev-1')), (e: unknown) => e instanceof NotFoundError);
});

test('РОП записывает клиента оператора: заслуга — РОП, ответственный — владелец карточки', async () => {
  const r = await createBooking(deps, rop, req('cl-b-3', 'ev-1'));
  assert.equal(r.booking.bookedByUserId, U.rop);
  assert.equal(r.booking.responsibleUserId, U.opB);
  assert.equal(opB.userId, U.opB);
});

test('импорт (система): занесение в прошедшее мероприятие из карточки в любом состоянии, автор из таблицы', async () => {
  await setCardState(db.sql, 'cd-a-9', 'new');
  const sys = systemActor('import-bookings', SEED_NOW);
  const r = await createBooking(deps, sys, req('cl-a-9', 'ev-past'), { imported: { importKey: 'imp:1', bookedByUserId: U.opB } });
  assert.equal(r.booking.via, 'import');
  assert.equal(r.booking.bookedByUserId, U.opB);
  assert.equal(r.booking.responsibleUserId, U.opA);
  const unknown = await createBooking(deps, sys, req('cl-a-10', 'ev-past'), { imported: { importKey: 'imp:2', bookedByUserId: null } });
  assert.equal(unknown.booking.bookedByUserId, null, 'автор неизвестен — NULL, а не выдуманный');
});

test('индивидуальная запись в B2 не реализована: ошибка сборки, а не ответ пользователю', async () => {
  await assert.rejects(
    createBooking(deps, opA, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-1', eventTypeKey: 'consult', date: '2026-10-29', time: '11:00', directionKey: '', resourceId: null, contactId: null }),
    /B3a/,
  );
});
