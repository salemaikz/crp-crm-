// Маршруты записи через обёртку route() (§3, §4, §10): «чужое = несуществующее» байт в байт, 423 у директора,
// 403 у оператора на разделы РОП, дежурный видит гостей, но не карточку; и весь набор маршрутов «по кругу»
// на живых телах Zod.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSql, scoped } from '../../../src/server/access/scope';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { overrideBookingDepsForTests } from '../../../src/server/domain/booking/deps';
import { unavailableCardPort } from '../../../src/server/domain/booking/cardPort';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import * as eventsRoot from '../../../src/app/api/events/route';
import * as eventsOffer from '../../../src/app/api/events/offer/route';
import * as eventsById from '../../../src/app/api/events/[id]/route';
import * as eventsCancel from '../../../src/app/api/events/[id]/cancel/route';
import * as eventsDuty from '../../../src/app/api/events/[id]/duty/route';
import * as eventsGuests from '../../../src/app/api/events/[id]/guests/route';
import * as seriesRoot from '../../../src/app/api/events/series/route';
import * as seriesById from '../../../src/app/api/events/series/[id]/route';
import * as bookingsRoot from '../../../src/app/api/bookings/route';
import * as bookingsWizard from '../../../src/app/api/bookings/wizard/[cardId]/route';
import * as bookingsById from '../../../src/app/api/bookings/[id]/route';
import * as bookingsConfirm from '../../../src/app/api/bookings/[id]/confirm/route';
import * as bookingsCancel from '../../../src/app/api/bookings/[id]/cancel/route';
import * as bookingsMove from '../../../src/app/api/bookings/[id]/move/route';
import * as bookingsAttendance from '../../../src/app/api/bookings/[id]/attendance/route';
import { SEED_NOW, actAs, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

const ORIGIN = 'http://crm.test';
type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown> & unknown[];
}

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
const port = fakeCardPort();

async function call(handler: Handler, method: string, path: string, o: { as: string | null; body?: unknown; params?: Record<string, string>; origin?: boolean } = { as: null }): Promise<Reply> {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET' && o.origin !== false) headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let json: Reply['json'];
  try {
    json = JSON.parse(text) as Reply['json'];
  } catch {
    json = {} as Reply['json'];
  }
  return { status: res.status, text, json };
}

async function snapshot(): Promise<string> {
  const [b, h, f, e, d] = await Promise.all([
    db.sql`SELECT * FROM bookings ORDER BY id`,
    db.sql`SELECT * FROM booking_history ORDER BY id`,
    db.sql`SELECT * FROM client_events ORDER BY id`,
    db.sql`SELECT * FROM events ORDER BY id`,
    db.sql`SELECT * FROM deals ORDER BY id`,
  ]);
  return JSON.stringify([b, h, f, e, d]);
}

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, port);
  overrideBookingDepsForTests(deps);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'iso-future', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'iso-today', date: '2026-10-28', time: '09:00' });
  await seedEvent(db.sql, { id: 'iso-tomorrow', date: '2026-10-29', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('iso-today', ${U.duty}, ${SEED_NOW})`;
});
after(async () => {
  overrideBookingDepsForTests(null);
  await closeWorld(db);
});

test('оператор B: чужая запись A — тот же 404, что у несуществующего id; строки не меняются', async () => {
  const mine = (await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-1', eventId: 'iso-future', contactId: null })).booking;
  const before = await snapshot();
  const op = uuid();
  const attempts: Array<[string, Handler, string, string, unknown]> = [
    ['GET', bookingsById.GET, '/api/bookings/x', 'GET', undefined],
    ['POST', bookingsConfirm.POST, '/api/bookings/x/confirm', 'POST', { opId: op, version: 0, to: 'confirmed' }],
    ['POST', bookingsCancel.POST, '/api/bookings/x/cancel', 'POST', { opId: op, version: 0, reason: 'client' }],
    ['POST', bookingsMove.POST, '/api/bookings/x/move', 'POST', { requestId: op, version: 0, eventId: 'iso-tomorrow' }],
    ['POST', bookingsAttendance.POST, '/api/bookings/x/attendance', 'POST', { opId: op, version: 0, to: 'attended' }],
  ];
  for (const [, handler, path, method, body] of attempts) {
    const foreign = await call(handler, method, path, { as: U.opB, params: { id: mine.id }, body });
    const missing = await call(handler, method, path, { as: U.opB, params: { id: 'no-such-booking' }, body });
    assert.equal(foreign.status, 404, `${method} ${path}`);
    assert.equal(foreign.text, missing.text, `${path}: тело как у несуществующего`);
    const own = await call(handler, method, path, { as: U.opA, params: { id: 'no-such-booking' }, body });
    assert.equal(own.text, missing.text);
  }
  assert.equal(await snapshot(), before, 'ни одна таблица записи не изменилась');
});

test('список и мастер оператора B без чужого; запись чужого клиента — 404 как у несуществующего', async () => {
  const list = await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31', { as: U.opB });
  assert.equal(list.status, 200);
  assert.ok((list.json as unknown as Array<{ clientId: string }>).every((b) => !b.clientId.startsWith('cl-a-')));
  const listA = await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31', { as: U.opA });
  assert.ok((listA.json as unknown as Array<{ clientId: string }>).some((b) => b.clientId === 'cl-a-1'));

  // фильтры списка: статусы через запятую, клиент, мероприятие; неизвестный статус — 400
  const filtered = await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31&status=registered,confirmed&clientId=cl-a-1&eventId=iso-future', { as: U.opA });
  assert.deepEqual((filtered.json as unknown as Array<{ clientId: string; eventId: string }>).map((b) => [b.clientId, b.eventId]), [['cl-a-1', 'iso-future']]);
  const none = await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31&status=attended&clientId=cl-a-1', { as: U.opA });
  assert.deepEqual(none.json, []);
  assert.equal((await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31&status=wrong', { as: U.opA })).status, 400);
  assert.equal((await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01', { as: U.opA })).status, 400);

  const foreignOffer = await call(eventsOffer.GET, 'GET', '/api/events/offer?clientId=cl-a-1', { as: U.opB });
  const missingOffer = await call(eventsOffer.GET, 'GET', '/api/events/offer?clientId=cl-none', { as: U.opB });
  assert.equal(foreignOffer.status, 404);
  assert.equal(foreignOffer.text, missingOffer.text);

  const body = (clientId: string) => ({ kind: 'group', requestId: uuid(), clientId, eventId: 'iso-future', contactId: null });
  const foreign = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opB, body: body('cl-a-2') });
  const missing = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opB, body: body('cl-none') });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text);
});

test('дежурный видит всех гостей своего мероприятия сегодня и не видит карточку клиента; записывать и править не может', async () => {
  await seedBookings(db.sql, 'iso-today', [{ client: 'cl-a-5', card: 'cd-a-5' }], { bookedBy: U.opA });
  await seedBookings(db.sql, 'iso-today', [{ client: 'cl-b-5', card: 'cd-b-5' }], { bookedBy: U.opB });
  const guests = await call(eventsGuests.GET, 'GET', '/api/events/iso-today/guests', { as: U.duty, params: { id: 'iso-today' } });
  assert.equal(guests.status, 200);
  assert.equal((guests.json as unknown as unknown[]).length, 2);

  const duty = await viewerOf(U.duty);
  const cards = await scoped(db.sql)<{ id: string }>`SELECT c.id FROM cards c WHERE c.id IN ('cd-a-5', 'cd-b-5') AND ${scopeSql(duty, 'card', 'card.read')}`;
  assert.deepEqual(cards, [], 'карточка гостя дежурному не видна');
  const post = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.duty, body: { kind: 'group', requestId: uuid(), clientId: 'cl-a-6', eventId: 'iso-future', contactId: null } });
  assert.equal(post.status, 404, 'дежурный не записывает: клиента для него нет');
  const create = await call(eventsRoot.POST, 'POST', '/api/events', { as: U.duty, body: { requestId: uuid(), eventTypeKey: 'br', eventDate: '2026-11-26', startTime: '15:00' } });
  assert.equal(create.status, 403);

  // явка своего мероприятия сегодня — да (карточка в «Договорились»: порт получает событие)
  const [bookingId] = (await db.sql<{ id: string }>`SELECT id FROM bookings WHERE client_id = 'cl-a-5' AND event_id = 'iso-today'`).map((r) => r.id);
  const attended = await call(bookingsAttendance.POST, 'POST', `/api/bookings/${bookingId}/attendance`, { as: U.duty, params: { id: bookingId! }, body: { opId: uuid(), version: 0, to: 'attended' } });
  assert.equal(attended.status, 200);
  assert.equal(attended.json.status, 'attended');
});

test('директор: чтение 200, любая мутация — 423; оператор на разделах РОП — 403; без Origin — 403; без сессии — 401', async () => {
  const id = (await db.sql<{ id: string }>`SELECT id FROM bookings WHERE client_id = 'cl-a-1'`)[0]!.id;
  const mutations: Array<[Handler, string, string, Record<string, string>, unknown]> = [
    [bookingsRoot.POST, 'POST', '/api/bookings', {}, { kind: 'group', requestId: uuid(), clientId: 'cl-a-9', eventId: 'iso-future', contactId: null }],
    [bookingsConfirm.POST, 'POST', `/api/bookings/${id}/confirm`, { id }, { opId: uuid(), version: 0, to: 'confirmed' }],
    [bookingsCancel.POST, 'POST', `/api/bookings/${id}/cancel`, { id }, { opId: uuid(), version: 0, reason: 'client' }],
    [bookingsMove.POST, 'POST', `/api/bookings/${id}/move`, { id }, { requestId: uuid(), version: 0, eventId: 'iso-tomorrow' }],
    [bookingsAttendance.POST, 'POST', `/api/bookings/${id}/attendance`, { id }, { opId: uuid(), version: 0, to: 'attended' }],
    [eventsRoot.POST, 'POST', '/api/events', {}, { requestId: uuid(), eventTypeKey: 'br', eventDate: '2026-11-26', startTime: '15:00' }],
    [eventsById.PATCH, 'PATCH', '/api/events/iso-future', { id: 'iso-future' }, { seenUpdatedAt: 0, patch: { capacity: 20 } }],
    [eventsCancel.POST, 'POST', '/api/events/iso-future/cancel', { id: 'iso-future' }, { opId: uuid() }],
    [eventsDuty.PUT, 'PUT', '/api/events/iso-future/duty', { id: 'iso-future' }, { userIds: [] }],
    [seriesRoot.POST, 'POST', '/api/events/series', {}, { requestId: uuid(), eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: '', format: 'offline', capacity: 30 }],
    [seriesById.PATCH, 'PATCH', '/api/events/series/x', { id: 'x' }, { seenUpdatedAt: 0, patch: { active: false } }],
  ];
  const snap = await snapshot();
  for (const [handler, method, path, params, body] of mutations) {
    const r = await call(handler, method, path, { as: U.director, params, body });
    assert.equal(r.status, 423, `${method} ${path}`);
  }
  assert.equal(await snapshot(), snap);
  assert.equal((await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31', { as: U.director })).status, 200);
  assert.equal((await call(eventsRoot.GET, 'GET', '/api/events?from=2026-10-01&to=2026-11-30', { as: U.director })).status, 200);

  assert.equal((await call(seriesRoot.GET, 'GET', '/api/events/series', { as: U.opA })).status, 403);
  assert.equal((await call(eventsRoot.POST, 'POST', '/api/events', { as: U.opA, body: mutations[5]![4] })).status, 403);
  assert.equal((await call(eventsCancel.POST, 'POST', '/api/events/iso-future/cancel', { as: U.opA, params: { id: 'iso-future' }, body: { opId: uuid() } })).status, 404, 'объектное право: нет права = 404');
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.rop, origin: false, body: mutations[0]![4] })).status, 403);
  assert.equal((await call(bookingsRoot.GET, 'GET', '/api/bookings?from=2026-10-01&to=2026-12-31', { as: null })).status, 401);
  // консультант: право на раздел по отношению, но групповые записи не трогает
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.consultant, body: mutations[0]![4] })).status, 404);
});

test('валидация тел и ответы на ошибки домена: 400, 409 с кодом, event_full с альтернативами, 201/200', async () => {
  const good = { kind: 'group', requestId: uuid(), clientId: 'cl-a-10', eventId: 'iso-future', contactId: null };
  for (const bad of [{ ...good, extra: 1 }, { ...good, requestId: 'не-uuid' }, { ...good, kind: 'individual' }, { kind: 'group' }, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-10', eventTypeKey: 'bk', date: '2026-11-03', time: '10:30', directionKey: 'marketing', resourceId: 5, contactId: null }]) {
    assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: bad })).status, 400);
  }
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: undefined })).status, 400, 'пустое тело');
  const created = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: good });
  assert.equal(created.status, 201);
  assert.equal((created.json.booking as { status: string }).status, 'registered');
  const replay = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: good });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);

  const dup = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: { ...good, requestId: uuid() } });
  assert.deepEqual([dup.status, dup.json], [409, { error: 'conflict', detail: 'already_registered' }]);

  await db.sql`UPDATE cards SET state = 'callback' WHERE id = 'cd-a-11'`;
  const outcome = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: { ...good, requestId: uuid(), clientId: 'cl-a-11' } });
  assert.deepEqual([outcome.status, outcome.json], [409, { error: 'conflict', detail: 'outcome_required' }]);

  await seedEvent(db.sql, { id: 'iso-one-seat', date: '2026-11-19', time: '15:00', capacity: 1 });
  await seedBookings(db.sql, 'iso-one-seat', [{ client: 'cl-b-9', card: 'cd-b-9' }]);
  const full = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: { ...good, requestId: uuid(), clientId: 'cl-a-12', eventId: 'iso-one-seat' } });
  assert.equal(full.status, 409);
  assert.equal(full.json.detail, 'event_full');
  assert.ok(Array.isArray(full.json.alternatives) && (full.json.alternatives as unknown[]).length > 0);

  // до C5 события карточки недоступны: явка при «Договорились» → 503
  overrideBookingDepsForTests({ ...deps, cards: unavailableCardPort });
  try {
    await seedBookings(db.sql, 'iso-today', [{ client: 'cl-a-13', card: 'cd-a-13' }], { bookedBy: U.opA });
    const id = (await db.sql<{ id: string }>`SELECT id FROM bookings WHERE client_id = 'cl-a-13'`)[0]!.id;
    const r = await call(bookingsAttendance.POST, 'POST', `/api/bookings/${id}/attendance`, { as: U.rop, params: { id }, body: { opId: uuid(), version: 0, to: 'no_show' } });
    assert.deepEqual([r.status, r.json], [503, { error: 'internal', detail: 'card_port_unavailable' }]);
    const row = (await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${id}`)[0];
    assert.equal(row?.status, 'registered', 'действие откатилось целиком');
  } finally {
    overrideBookingDepsForTests(deps);
  }
});

test('все маршруты «по кругу» на живых телах: мероприятие, серия, дежурные, запись, перенос, подтверждение, явка, отмена', async () => {
  const asRop = { as: U.rop };
  // мероприятие
  const evReq = uuid();
  const ev = await call(eventsRoot.POST, 'POST', '/api/events', { ...asRop, body: { requestId: evReq, eventTypeKey: 'br', eventDate: '2026-12-03', startTime: '15:00' } });
  assert.equal(ev.status, 200);
  assert.equal(ev.json.id, evReq);
  const got = await call(eventsById.GET, 'GET', `/api/events/${evReq}`, { ...asRop, params: { id: evReq } });
  assert.equal(got.status, 200);
  const patched = await call(eventsById.PATCH, 'PATCH', `/api/events/${evReq}`, { ...asRop, params: { id: evReq }, body: { seenUpdatedAt: got.json.updatedAt, patch: { capacity: 25 } } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.capacity, 25);
  const stale = await call(eventsById.PATCH, 'PATCH', `/api/events/${evReq}`, { ...asRop, params: { id: evReq }, body: { seenUpdatedAt: got.json.updatedAt, patch: { capacity: 26 } } });
  assert.deepEqual([stale.status, stale.json], [409, { error: 'conflict' }]);
  const duty = await call(eventsDuty.PUT, 'PUT', `/api/events/${evReq}/duty`, { ...asRop, params: { id: evReq }, body: { userIds: [U.duty] } });
  assert.deepEqual([duty.status, duty.json], [200, { userIds: [U.duty] }]);
  const list = await call(eventsRoot.GET, 'GET', '/api/events?from=2026-12-03&to=2026-12-03&type=br', asRop);
  assert.equal((list.json as unknown as unknown[]).length, 1);

  // серия
  const sReq = uuid();
  const series = await call(seriesRoot.POST, 'POST', '/api/events/series', { ...asRop, body: { requestId: sReq, eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: 'Зал', format: 'offline', capacity: 30 } });
  assert.equal(series.status, 200);
  assert.equal((series.json.series as { id: string }).id, sReq);
  assert.ok((series.json.sync as { created: number }).created > 0);
  const seriesList = await call(seriesRoot.GET, 'GET', '/api/events/series', asRop);
  assert.equal((seriesList.json as unknown as unknown[]).length, 1);
  const sPatched = await call(seriesById.PATCH, 'PATCH', `/api/events/series/${sReq}`, { ...asRop, params: { id: sReq }, body: { seenUpdatedAt: (series.json.series as { updatedAt: number }).updatedAt, patch: { capacity: 28 } } });
  assert.equal(sPatched.status, 200);
  assert.equal((sPatched.json.series as { capacity: number }).capacity, 28);

  // запись → перенос → подтверждение → отмена; мастер
  const offer = await call(eventsOffer.GET, 'GET', '/api/events/offer?clientId=cl-a-20&type=br', { as: U.opA });
  assert.equal(offer.status, 200);
  const first = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: { kind: 'group', requestId: uuid(), clientId: 'cl-a-20', eventId: evReq, contactId: null } });
  assert.equal(first.status, 201);
  const bid = (first.json.booking as { id: string }).id;
  const one = await call(bookingsById.GET, 'GET', `/api/bookings/${bid}`, { as: U.opA, params: { id: bid } });
  assert.equal(one.status, 200);
  const confirmed = await call(bookingsConfirm.POST, 'POST', `/api/bookings/${bid}/confirm`, { as: U.opA, params: { id: bid }, body: { opId: uuid(), version: 0, to: 'confirmed' } });
  assert.equal(confirmed.json.status, 'confirmed');
  const moved = await call(bookingsMove.POST, 'POST', `/api/bookings/${bid}/move`, { as: U.opA, params: { id: bid }, body: { requestId: uuid(), version: 1, eventId: 'iso-future' } });
  assert.equal(moved.status, 201);
  assert.equal(moved.json.action, 'moved');
  const bid2 = (moved.json.booking as { id: string }).id;
  const cancelled = await call(bookingsCancel.POST, 'POST', `/api/bookings/${bid2}/cancel`, { as: U.opA, params: { id: bid2 }, body: { opId: uuid(), version: 0, reason: 'client' } });
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(port.calls.at(-1)?.event.type, 'booking_cancelled');

  // отмена мероприятия каскадом
  const cancelEv = await call(eventsCancel.POST, 'POST', `/api/events/${evReq}/cancel`, { ...asRop, params: { id: evReq }, body: { opId: uuid() } });
  assert.equal(cancelEv.status, 200);
  assert.equal((cancelEv.json.event as { status: string }).status, 'cancelled');
});

test('мастер записи: чужая карточка — 404 байт в байт как несуществующая; своя — 200 без лишних полей', async () => {
  const foreign = await call(bookingsWizard.GET, 'GET', '/api/bookings/wizard/cd-a-1', { as: U.opB, params: { cardId: 'cd-a-1' } });
  const missing = await call(bookingsWizard.GET, 'GET', '/api/bookings/wizard/нет-такой', { as: U.opB, params: { cardId: 'нет-такой' } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text);
  const own = await call(bookingsWizard.GET, 'GET', '/api/bookings/wizard/cd-a-1', { as: U.opA, params: { cardId: 'cd-a-1' } });
  assert.equal(own.status, 200);
  assert.deepEqual(Object.keys(own.json).sort(), ['cardId', 'clientId', 'clientName', 'consultOffers', 'groupOffers', 'mode', 'timeZone', 'today', 'types']);
  assert.equal((await call(bookingsWizard.GET, 'GET', '/api/bookings/wizard/cd-a-1', { as: U.consultant, params: { cardId: 'cd-a-1' } })).status, 404, 'консультант по booked_with_me не пишет групповые');
  assert.equal((await call(bookingsWizard.GET, 'GET', '/api/bookings/wizard/cd-a-1', { as: null, params: { cardId: 'cd-a-1' } })).status, 401);
});

test('заявка на консультацию через маршрут: 201/200, чужой клиент — 404 без изменений, resourceId строкой — 400', async () => {
  const body = (clientId: string, over: Record<string, unknown> = {}) => ({
    kind: 'individual', requestId: uuid(), clientId, eventTypeKey: 'bk', date: '2026-10-29', time: '10:30', directionKey: 'marketing', resourceId: null, contactId: null, ...over,
  });
  const good = body('cl-a-14');
  const created = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: good });
  assert.equal(created.status, 201);
  assert.equal((created.json.booking as { kind: string }).kind, 'individual');
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: good })).status, 200);

  const before = await snapshot();
  const foreign = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opB, body: body('cl-a-15') });
  const missing = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opB, body: body('cl-none') });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, missing.text);
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: body('cl-a-15', { resourceId: 5 }) })).status, 400);
  // консультант в теле допустим, но без флага BK_WIZARD запись к нему не существует
  assert.equal((await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: body('cl-a-15', { resourceId: 'r1' }) })).status, 404);
  assert.equal(await snapshot(), before, 'таблицы не изменились');
  const late = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: body('cl-a-15', { time: '10:20' }) });
  assert.deepEqual([late.status, late.json], [409, { error: 'conflict', detail: 'outside_hours' }]);
});
