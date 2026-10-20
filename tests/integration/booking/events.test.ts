// Мероприятия (B2, §5.4–5.6, D-136, D-137): разовое мероприятие с умолчаниями, правка с токеном, дежурные,
// список гостей без лишних ПДн, мастер записи, места по всем записям без охвата записей.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { createEvent, getEvent, listEvents, listGuests, offerEvents, setEventDuty, updateEvent } from '../../../src/server/domain/booking/events';
import { createSeries } from '../../../src/server/domain/booking/series';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, phoneOf } from '../../isolation/harness/seed';
import { SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let opA: Viewer;
let opB: Viewer;
let duty: Viewer;
let director: Viewer;

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  duty = await viewerOf(U.duty);
  director = await viewerOf(U.director);
});
after(() => closeWorld(db));

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const newEvent = (over: Partial<Parameters<typeof createEvent>[2]> = {}) => ({ requestId: uuid(), eventTypeKey: 'br', eventDate: '2026-11-26', startTime: '15:00', ...over });
const updatedAt = async (id: string) => (await db.sql<{ u: number }>`SELECT updated_at AS u FROM events WHERE id = ${id}`)[0]!.u;

test('разовое мероприятие: умолчания места и формата — из стартовой серии, затем из действующей серии вида', async () => {
  const a = await createEvent(deps, rop, newEvent());
  assert.deepEqual([a.location, a.format, a.capacity, a.durationMin, a.seriesId, a.touched, a.status], ['Зал 1', 'offline', 30, 180, null, false, 'scheduled']);
  assert.equal(a.startsAt, Date.UTC(2026, 10, 26, 10, 0), '15:00 по Алматы = 10:00 UTC');
  assert.deepEqual(a.seats, { capacity: 30, taken: 0, left: 30 });

  await createSeries(deps, rop, { requestId: uuid(), eventTypeKey: 'br', weekday: 5, startTime: '14:00', durationMin: 120, location: 'Зал 5', format: 'online', capacity: 20 });
  const b = await createEvent(deps, rop, newEvent({ eventDate: '2026-11-27', startTime: '18:30' }));
  assert.deepEqual([b.location, b.format, b.capacity, b.durationMin], ['Зал 5', 'online', 30, 180], 'место и формат — из серии, остальное — из вида');
  const c = await createEvent(deps, rop, newEvent({ eventDate: '2026-11-28', location: 'Переговорная', format: 'offline', capacity: 12, durationMin: 90 }));
  assert.deepEqual([c.location, c.format, c.capacity, c.durationMin], ['Переговорная', 'offline', 12, 90]);
  const audit = await db.sql<{ action: string }>`SELECT action FROM audit_log WHERE entity = 'event' AND action = 'event.create'`;
  assert.equal(audit.length, 3);
});

test('повтор ключа — то же мероприятие; другое содержимое — request_reused; оператор и директор не создают', async () => {
  const body = newEvent({ eventDate: '2026-11-30' });
  const a = await createEvent(deps, rop, body);
  const b = await createEvent(deps, rop, body);
  assert.equal(a.id, b.id);
  assert.equal(a.id, body.requestId);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM events WHERE id = ${body.requestId}`)[0]?.n, 1);
  await assert.rejects(createEvent(deps, rop, { ...body, startTime: '16:00' }), failsWith('request_reused'));
  await assert.rejects(createEvent(deps, opA, newEvent()), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(createEvent(deps, director, newEvent()), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(createEvent(deps, rop, newEvent({ eventTypeKey: 'unknown_type' })), failsWith('invalid_settings'));
  await assert.rejects(createEvent(deps, rop, newEvent({ eventDate: '2026-10-20' })), failsWith('event_in_past'));
  await assert.rejects(createEvent(deps, rop, newEvent({ eventDate: '2026-02-30' })), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(createEvent(deps, rop, newEvent({ format: 'weird' as never })), (e: unknown) => e instanceof BadRequestError);
});

test('правка: вместимость ниже занятого, дата с записями, устаревший токен, прошлое — отказы; успех ставит touched', async () => {
  const ev = await createEvent(deps, rop, newEvent({ eventDate: '2026-12-02', capacity: 10 }));
  await seedBookings(db.sql, ev.id, [{ client: 'cl-a-1', card: 'cd-a-1' }, { client: 'cl-a-2', card: 'cd-a-2' }, { client: 'cl-a-3', card: 'cd-a-3' }]);
  const seen = await updatedAt(ev.id);
  await assert.rejects(updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen, patch: { capacity: 2 } }), failsWith('capacity_below_taken'));
  await assert.rejects(updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen, patch: { eventDate: '2026-12-03' } }), failsWith('event_has_bookings'));
  await assert.rejects(updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen, patch: { startTime: '16:00' } }), failsWith('event_has_bookings'));
  await assert.rejects(updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen - 1, patch: { capacity: 12 } }), (e: unknown) => e instanceof ConflictError);
  await assert.rejects(updateEvent(deps, opA, { eventId: ev.id, seenUpdatedAt: seen, patch: { capacity: 12 } }), (e: unknown) => e instanceof ForbiddenError);

  const ok = await updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen, patch: { capacity: 3, location: 'Новый зал' } });
  assert.deepEqual([ok.capacity, ok.location, ok.touched, ok.seats.left], [3, 'Новый зал', true, 0]);
  assert.ok(ok.updatedAt > seen);
  // тот же токен второй раз — уже устарел
  await assert.rejects(updateEvent(deps, rop, { eventId: ev.id, seenUpdatedAt: seen, patch: { capacity: 4 } }), (e: unknown) => e instanceof ConflictError);

  // пустое мероприятие: дату и время менять можно, startsAt пересчитывается; в прошлое — нельзя
  const empty = await createEvent(deps, rop, newEvent({ eventDate: '2026-12-05' }));
  const moved = await updateEvent(deps, rop, { eventId: empty.id, seenUpdatedAt: await updatedAt(empty.id), patch: { eventDate: '2026-12-06', startTime: '11:30' } });
  assert.deepEqual([moved.eventDate, moved.startTime, moved.startsAt], ['2026-12-06', '11:30', Date.UTC(2026, 11, 6, 6, 30)]);
  await assert.rejects(updateEvent(deps, rop, { eventId: empty.id, seenUpdatedAt: moved.updatedAt, patch: { eventDate: '2026-10-01' } }), failsWith('event_in_past'));
  await assert.rejects(updateEvent(deps, rop, { eventId: 'no-such', seenUpdatedAt: 0, patch: {} }), failsWith('event_not_found'));
});

test('дежурные: активные сотрудники пространства, не больше десяти; отключённый и посторонний — отказ', async () => {
  const ev = await createEvent(deps, rop, newEvent({ eventDate: '2026-12-08' }));
  assert.deepEqual((await setEventDuty(deps, rop, { eventId: ev.id, userIds: [U.duty, U.consultant, U.duty] })).userIds.sort(), [U.consultant, U.duty].sort());
  assert.deepEqual((await setEventDuty(deps, rop, { eventId: ev.id, userIds: [U.opB] })).userIds, [U.opB], 'список заменяется целиком');
  await assert.rejects(setEventDuty(deps, rop, { eventId: ev.id, userIds: [U.disabled] }), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(setEventDuty(deps, rop, { eventId: ev.id, userIds: [U.admin] }), (e: unknown) => e instanceof BadRequestError, 'без членства в пространстве');
  await assert.rejects(setEventDuty(deps, rop, { eventId: ev.id, userIds: Array.from({ length: 11 }, (_, i) => `u-${i}`) }), (e: unknown) => e instanceof BadRequestError);
  assert.deepEqual((await setEventDuty(deps, rop, { eventId: ev.id, userIds: [] })).userIds, []);
  await assert.rejects(setEventDuty(deps, opA, { eventId: ev.id, userIds: [] }), (e: unknown) => e instanceof ForbiddenError);
  const audit = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'event.duty' AND entity_id = ${ev.id}`;
  assert.equal(audit[0]?.n, 3);
});

test('гости: строки по охвату, имя/контакт/хвост номера; полного номера и custom в ответе нет', async () => {
  await seedEvent(db.sql, { id: 'ev-guests', date: '2026-10-28', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('ev-guests', ${U.duty}, ${SEED_NOW})`;
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-g1', 'cl-a-1', 'Контакт Гостевой', ${SEED_NOW})`;
  await seedBookings(db.sql, 'ev-guests', [{ client: 'cl-a-1', card: 'cd-a-1' }, { client: 'cl-a-2', card: 'cd-a-2' }], { bookedBy: U.opA });
  await seedBookings(db.sql, 'ev-guests', [{ client: 'cl-b-1', card: 'cd-b-1' }], { bookedBy: U.opB });
  await db.sql`UPDATE bookings SET contact_id = 'ct-g1' WHERE client_id = 'cl-a-1' AND event_id = 'ev-guests'`;
  await db.sql`UPDATE clients SET custom = '{"secret":"зашифрованное значение"}' WHERE id = 'cl-a-1'`;

  const forA = await listGuests(deps, opA, 'ev-guests');
  assert.equal(forA.length, 2, 'оператор видит только своих гостей');
  const forRop = await listGuests(deps, rop, 'ev-guests');
  assert.equal(forRop.length, 3);
  const forDuty = await listGuests(deps, duty, 'ev-guests');
  assert.equal(forDuty.length, 3, 'дежурный видит всех гостей своего мероприятия сегодня');

  const g = forDuty.find((r) => r.clientName.endsWith('Альфа 1'))!;
  assert.deepEqual(Object.keys(g).sort(), ['bookedByName', 'bookingId', 'clientName', 'contactName', 'phoneTail', 'status', 'version', 'via']);
  assert.equal(g.contactName, 'Контакт Гостевой');
  assert.equal(g.phoneTail, phoneOf('a', 1).slice(-4));
  assert.equal(g.bookedByName, 'Оператор Синтетик А');
  const json = JSON.stringify(forDuty);
  assert.ok(!json.includes(phoneOf('a', 1)) && !json.includes(phoneOf('a', 1).slice(-7)), 'полного номера нет');
  assert.ok(!json.includes('secret') && !json.includes('custom') && !json.includes('зашифрованное'));

  // дежурный не видит карточку клиента: он видит только гостей
  await assert.rejects(listGuests(deps, opA, 'no-such'), failsWith('event_not_found'));
  await seedEvent(db.sql, { id: 'ev-guests-tomorrow', date: '2026-10-29', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('ev-guests-tomorrow', ${U.duty}, ${SEED_NOW})`;
  await seedBookings(db.sql, 'ev-guests-tomorrow', [{ client: 'cl-a-3', card: 'cd-a-3' }]);
  assert.deepEqual(await listGuests(deps, duty, 'ev-guests-tomorrow'), [], 'дежурство «сегодня» — гостей завтрашнего мероприятия дежурный не видит');
});

test('места считаются по всем записям мероприятия без охвата записей (D-136)', async () => {
  const ev = await createEvent(deps, rop, newEvent({ eventDate: '2026-12-10', capacity: 5 }));
  await createBooking(deps, opB, { kind: 'group', requestId: uuid(), clientId: 'cl-b-20', eventId: ev.id, contactId: null });
  await createBooking(deps, opB, { kind: 'group', requestId: uuid(), clientId: 'cl-b-21', eventId: ev.id, contactId: null });
  const seenByA = await getEvent(opA, ev.id);
  assert.deepEqual(seenByA.seats, { capacity: 5, taken: 2, left: 3 }, 'оператор A видит «осталось 3 из 5», не видя гостей B');
  assert.equal((await listGuests(deps, opA, ev.id)).length, 0);
  const list = await listEvents(deps, opA, { from: '2026-12-10', to: '2026-12-10' });
  assert.deepEqual(list.map((e) => [e.id, e.seats.taken]), [[ev.id, 2]]);
  await assert.rejects(getEvent(opA, 'no-such'), failsWith('event_not_found'));
});

test('список: окно дат проверяется; отменённые — по флагу', async () => {
  const ev = await createEvent(deps, rop, newEvent({ eventDate: '2026-12-15' }));
  await db.sql`UPDATE events SET status = 'cancelled' WHERE id = ${ev.id}`;
  const without = await listEvents(deps, rop, { from: '2026-12-15', to: '2026-12-15' });
  const withIt = await listEvents(deps, rop, { from: '2026-12-15', to: '2026-12-15', includeCancelled: true });
  assert.deepEqual([without.length, withIt.map((e) => e.id)], [0, [ev.id]]);
  await assert.rejects(listEvents(deps, rop, { from: '2026-12-15', to: '2027-03-01' }), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(listEvents(deps, rop, { from: '2026-12-16', to: '2026-12-15' }), (e: unknown) => e instanceof BadRequestError);
  const byType = await listEvents(deps, rop, { from: '2026-12-01', to: '2026-12-31', eventTypeKey: 'other' });
  assert.equal(byType.length, 0);
});

test('мастер: ближайшие мероприятия с местами (не больше groupOptions), текущая запись клиента', async () => {
  await db.sql`UPDATE events SET status = 'cancelled' WHERE id NOT LIKE 'm-%'`; // остальные тесты файла не мешают мастеру
  await seedEvent(db.sql, { id: 'm-1', date: '2026-10-29', time: '15:00', capacity: 1 });
  await seedEvent(db.sql, { id: 'm-2', date: '2026-10-30', time: '15:00' });
  await seedEvent(db.sql, { id: 'm-3', date: '2026-10-31', time: '15:00' });
  await seedEvent(db.sql, { id: 'm-4', date: '2026-11-01', time: '15:00' });
  await seedEvent(db.sql, { id: 'm-5', date: '2026-11-02', time: '15:00' });
  await seedEvent(db.sql, { id: 'm-cancelled', date: '2026-10-29', time: '16:00', status: 'cancelled' });
  await seedEvent(db.sql, { id: 'm-far', date: '2027-06-01', time: '15:00' });
  await seedBookings(db.sql, 'm-1', [{ client: 'cl-b-30', card: 'cd-b-30' }]); // m-1 заполнено

  const offer = await offerEvents(deps, opA, { clientId: 'cl-a-30' });
  assert.deepEqual(offer.options.map((o) => o.id), ['m-2', 'm-3', 'm-4'], 'полное и отменённое пропущены, предложено groupOptions = 3');
  assert.equal(offer.current, null);
  assert.deepEqual(offer.options[0]?.seats, { capacity: 30, taken: 0, left: 30 });

  const made = await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-30', eventId: 'm-2', contactId: null });
  const again = await offerEvents(deps, opA, { clientId: 'cl-a-30', eventTypeKey: 'br' });
  assert.equal(again.current?.id, made.booking.id, 'новая запись станет переносом с этой');
  assert.ok(again.options.some((o) => o.id === 'm-2'));

  await assert.rejects(offerEvents(deps, opA, { clientId: 'cl-b-1' }), (e: unknown) => e instanceof NotFoundError, 'чужой клиент — как несуществующий');
  await assert.rejects(offerEvents(deps, opA, { clientId: 'cl-a-30', eventTypeKey: 'unknown_type' }), failsWith('invalid_settings'));
  const consultant = await viewerOf(U.consultant);
  await assert.rejects(offerEvents(deps, consultant, { clientId: 'cl-a-30' }), (e: unknown) => e instanceof ForbiddenError);
  assert.equal(opB.userId, U.opB);
});
