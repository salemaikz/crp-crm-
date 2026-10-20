// Заявка на консультацию без консультанта («серая», B3a, docs/booking-wizard-design.md §4): строка, история, лента,
// сделка, проверки вида, направления и слота, повтор ключа, перенос, независимость от групповой записи.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { booking, time } from '../../../packages/core/src';
import { BadRequestError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { cancelBooking, createBooking } from '../../../src/server/domain/booking/bookings';
import type { BookingDeps, IndividualBookingRequest } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { MIN, SEED_NOW, SEED_TZ, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedEvent, setCardState, uuid, viewerOf } from './helpers';

// SEED_NOW — среда 2026-10-28 11:00 (Asia/Almaty)
let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };
const port = fakeCardPort();

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps(clock, port);
  opA = await viewerOf(U.opA);
});
after(() => closeWorld(db));

const ask = (clientId: string, over: Partial<IndividualBookingRequest> = {}): IndividualBookingRequest => ({
  kind: 'individual',
  requestId: uuid(),
  clientId,
  eventTypeKey: 'bk',
  date: '2026-10-29',
  time: '09:45',
  directionKey: 'marketing',
  resourceId: null,
  contactId: null,
  ...over,
});
const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const count = async (clientId: string) => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${clientId}`)[0]!.n;

test('заявка на «Договорились»: строка без консультанта и мероприятия, история с grey, лента, сделка', async () => {
  const req = ask('cl-a-20');
  const r = await createBooking(deps, opA, req);
  assert.equal(r.action, 'created');
  assert.equal(r.replayed, false);
  const b = r.booking;
  assert.deepEqual([b.kind, b.eventId, b.resourceId, b.eventTypeKey, b.directionKey, b.durationMin, b.status, b.isReserve, b.via], ['individual', null, null, 'bk', 'marketing', 45, 'registered', false, 'ui']);
  assert.equal(b.bookingDate, '2026-10-29');
  assert.equal(b.startTime, '09:45');
  assert.equal(b.startsAt, booking.localToEpoch(SEED_TZ, '2026-10-29', '09:45'));
  assert.equal(b.bookedByUserId, U.opA);
  assert.equal(b.responsibleUserId, U.opA);
  assert.ok(b.dealId, 'сделка создана');

  const deals = await db.sql<{ id: string; requestId: string }>`SELECT id, request_id FROM deals WHERE card_id = 'cd-a-20'`;
  assert.deepEqual(deals.map((d) => [d.id, d.requestId]), [[b.dealId, req.requestId]]);
  const hist = await db.sql<{ action: string; meta: Record<string, unknown> }>`SELECT action, meta FROM booking_history WHERE booking_id = ${b.id}`;
  assert.deepEqual(hist.map((h) => h.action), ['created']);
  assert.equal(hist[0]!.meta.grey, true);
  const feed = await db.sql<{ kind: string; data: Record<string, unknown> }>`SELECT kind, data FROM client_events WHERE client_id = 'cl-a-20' AND kind LIKE 'booking.%'`;
  assert.deepEqual(feed.map((f) => f.kind), ['booking.created']);
  assert.deepEqual([feed[0]!.data.eventId, feed[0]!.data.directionKey, feed[0]!.data.eventTypeKey], [null, 'marketing', 'bk']);
  assert.equal(port.calls.length, 0, 'событий карточки нет');
});

test('карточка не в «Договорились»: outcome_required; в составе итога (fromOutcome) проходит', async () => {
  await setCardState(db.sql, 'cd-a-21', 'callback');
  await assert.rejects(createBooking(deps, opA, ask('cl-a-21')), failsWith('outcome_required'));
  assert.equal(await count('cl-a-21'), 0);
  const r = await createBooking(deps, opA, ask('cl-a-21'), { fromOutcome: { opId: uuid() } });
  assert.equal(r.action, 'created');
});

test('вид не индивидуальный и неизвестный: not_an_individual_event (409)', async () => {
  await assert.rejects(createBooking(deps, opA, ask('cl-a-22', { eventTypeKey: 'br' })), failsWith('not_an_individual_event'));
  await assert.rejects(createBooking(deps, opA, ask('cl-a-22', { eventTypeKey: 'нет-такого' })), failsWith('not_an_individual_event'));
  assert.equal(await count('cl-a-22'), 0);
});

test('чужое направление: 400, строки нет', async () => {
  await assert.rejects(createBooking(deps, opA, ask('cl-a-22', { directionKey: 'нет-такого' })), (e) => e instanceof BadRequestError);
  assert.equal(await count('cl-a-22'), 0);
});

test('слот: суббота, праздник, не по сетке, прошедший, дальше горизонта', async () => {
  const bad = async (over: Partial<IndividualBookingRequest>, code: string) => {
    await assert.rejects(createBooking(deps, opA, ask('cl-a-23', over)), failsWith(code), JSON.stringify(over));
  };
  await bad({ date: '2026-10-31' }, 'outside_hours');
  await bad({ time: '09:20' }, 'outside_hours');
  await bad({ time: '18:00' }, 'outside_hours');
  await bad({ date: '2026-12-31' }, 'outside_hours');
  await bad({ date: '2026-10-27' }, 'outside_hours');
  await bad({ date: '2026-10-28', time: '09:45' }, 'slot_in_past');
  const holiday = makeDeps(clock, port, { ...(await deps.settings('', 0)), calendar: time.createWorkCalendar({ timezone: SEED_TZ, workdays: [1, 2, 3, 4, 5], workHours: { start: '09:00', end: '18:00' }, callWindow: { start: '09:00', end: '18:00' }, holidays: [{ date: '2026-10-29', kind: 'holiday' }] }) });
  await assert.rejects(createBooking(holiday, opA, ask('cl-a-23')), failsWith('outside_hours'), 'праздник');
  assert.equal(await count('cl-a-23'), 0);
});

test('сегодняшний слот в будущем принимается', async () => {
  const r = await createBooking(deps, opA, ask('cl-a-24', { date: '2026-10-28', time: '12:00' }));
  assert.equal(r.booking.startTime, '12:00');
});

test('повтор ключа: replayed и одна строка; тот же ключ на другой слот — request_reused', async () => {
  const req = ask('cl-a-25');
  const first = await createBooking(deps, opA, req);
  const again = await createBooking(deps, opA, req);
  assert.equal(again.replayed, true);
  assert.equal(again.booking.id, first.booking.id);
  assert.equal(await count('cl-a-25'), 1);
  await assert.rejects(createBooking(deps, opA, { ...req, time: '10:30' }), failsWith('request_reused'));
  await assert.rejects(createBooking(deps, opA, { ...req, directionKey: 'consulting' }), failsWith('request_reused'));
  assert.equal(await count('cl-a-25'), 1);
});

test('вторая заявка другим ключом — перенос: заслуга и сделка прежние, старая moved, лента booking.moved', async () => {
  const first = await createBooking(deps, opA, ask('cl-a-26'));
  const second = await createBooking(deps, opA, ask('cl-a-26', { date: '2026-10-30', time: '10:30' }));
  assert.equal(second.action, 'moved');
  assert.ok(second.action === 'moved' && second.movedFromId === first.booking.id);
  assert.equal(second.booking.dealId, first.booking.dealId);
  assert.equal(second.booking.bookedByUserId, first.booking.bookedByUserId);
  assert.equal(second.booking.movedFromId, first.booking.id);
  const old = (await db.sql<{ status: string; movedToId: string }>`SELECT status, moved_to_id FROM bookings WHERE id = ${first.booking.id}`)[0]!;
  assert.deepEqual([old.status, old.movedToId], ['moved', second.booking.id]);
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE client_id = 'cl-a-26' AND kind = 'booking.moved'`;
  assert.deepEqual([feed[0]!.data.fromEventId, feed[0]!.data.toEventId], [null, null]);
  assert.equal(await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-a-26'`.then((x) => x[0]!.n), 1);
});

test('тот же день, время и направление другим ключом — already_registered', async () => {
  await createBooking(deps, opA, ask('cl-a-27'));
  await assert.rejects(createBooking(deps, opA, ask('cl-a-27')), failsWith('already_registered'));
  assert.equal(await count('cl-a-27'), 1);
});

test('групповая запись и заявка независимы: заявка не переносит БР и наоборот', async () => {
  await seedEvent(db.sql, { id: 'ev-ind-1', date: '2026-11-05', time: '15:00' });
  const g = await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-28', eventId: 'ev-ind-1', contactId: null });
  const i = await createBooking(deps, opA, ask('cl-a-28'));
  assert.equal(g.action, 'created');
  assert.equal(i.action, 'created');
  assert.equal(i.booking.dealId, g.booking.dealId, 'сделка одна');
  const active = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-28' AND status = 'registered'`;
  assert.equal(active[0]!.n, 2);
});

test('отмена «ошибка оператора» автором в первые 10 минут; позже — too_late', async () => {
  const r = await createBooking(deps, opA, ask('cl-a-29'));
  const early = await cancelBooking(deps, opA, { bookingId: r.booking.id, opId: uuid(), version: r.booking.version, reason: 'operator_error' });
  assert.deepEqual([early.status, early.cancelReason], ['cancelled', 'operator_error']);

  const r2 = await createBooking(deps, opA, ask('cl-a-30'));
  clock.now = SEED_NOW + 11 * MIN;
  try {
    await assert.rejects(cancelBooking(deps, opA, { bookingId: r2.booking.id, opId: uuid(), version: r2.booking.version, reason: 'operator_error' }), failsWith('too_late'));
  } finally {
    clock.now = SEED_NOW;
  }
});

test('запись к консультанту (resourceId) — B5: ошибка сборки', async () => {
  await assert.rejects(createBooking(deps, opA, ask('cl-a-31', { resourceId: 'r1' })), /B5/);
  assert.equal(await count('cl-a-31'), 0);
});

test('чужая карточка: 404, как у несуществующей', async () => {
  await assert.rejects(createBooking(deps, opA, ask('cl-b-1')), (e: unknown) => e instanceof NotFoundError);
});
