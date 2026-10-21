// Мероприятия экрана «Дежурство» (B4, §2.8): дежурный видит своё сегодня, РОП — все сегодняшние, оператор — ничего.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { getDutyCandidates, getDutyEvent, listDutyEvents } from '../../../src/server/domain/booking/duty';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let duty: Viewer;
let rop: Viewer;
let opA: Viewer;

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  duty = await viewerOf(U.duty);
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ev-mine', date: '2026-10-28', time: '09:00', capacity: 10 });
  await seedEvent(db.sql, { id: 'ev-pm', date: '2026-10-28', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-d-tomorrow', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-cancelled', date: '2026-10-28', time: '12:00', status: 'cancelled' });
  for (const ev of ['ev-mine', 'ev-d-tomorrow']) await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES (${ev}, ${U.duty}, ${SEED_NOW})`;
  const ids = await seedBookings(db.sql, 'ev-mine', clientsOf('a', 1, 5), { bookedBy: U.opA });
  await db.sql`UPDATE bookings SET status = 'attended' WHERE id = ${ids[0]!}`;
  await db.sql`UPDATE bookings SET status = 'no_show' WHERE id = ${ids[1]!}`;
  await db.sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${ids[4]!}`;
});
after(() => closeWorld(db));

// В мире изоляции дежурный уже дежурит на сегодняшнем мероприятии (FX.eventToday, 10:00 местного) и завтрашнем:
// сегодняшнее — тоже «своё сегодня» и в списке есть; завтрашнее — нет.
test('дежурный видит только свои мероприятия сегодня со счётчиками; завтрашнего и отменённого нет', async () => {
  const list = await listDutyEvents(deps, duty);
  assert.deepEqual(list.map((e) => e.id), ['ev-mine', FX.eventToday.event]);
  assert.ok(!list.some((e) => e.id === FX.eventTomorrow.event || e.id === 'ev-d-tomorrow' || e.id === 'ev-cancelled'));
  const e = list[0]!;
  assert.deepEqual(e.counts, { unmarked: 2, attended: 1, noShow: 1 });
  assert.equal(e.iAmDuty, true);
  assert.equal(e.started, true);
  assert.equal(e.seats.taken, 4);
});

test('РОП видит все сегодняшние запланированные, не будучи дежурным; завтрашнего нет', async () => {
  const list = await listDutyEvents(deps, rop);
  assert.deepEqual(list.map((e) => e.id), ['ev-mine', FX.eventToday.event, 'ev-pm']);
  assert.deepEqual(list.map((e) => e.iAmDuty), [false, false, false]);
  assert.deepEqual(list.map((e) => e.started), [true, true, false]);
});

test('оператор без дежурства — пусто, и отдельное мероприятие для него не существует', async () => {
  assert.deepEqual(await listDutyEvents(deps, opA), []);
  await assert.rejects(getDutyEvent(deps, opA, 'ev-mine'), (e: unknown) => e instanceof BookingDomainError && e.code === 'event_not_found');
  await assert.rejects(getDutyEvent(deps, duty, 'ev-pm'), (e: unknown) => e instanceof BookingDomainError && e.code === 'event_not_found');
  assert.equal((await getDutyEvent(deps, duty, 'ev-mine')).id, 'ev-mine');
});

test('кандидаты в дежурные: только РОП, активные сотрудники пространства по имени', async () => {
  const c = await getDutyCandidates(deps, rop, 'ev-mine');
  assert.deepEqual(c.userIds, [U.duty]);
  assert.ok(c.candidates.some((x) => x.userId === U.duty) && !c.candidates.some((x) => x.userId === U.disabled));
  const names = c.candidates.map((x) => x.name);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  await assert.rejects(getDutyCandidates(deps, duty, 'ev-mine'), (e: unknown) => e instanceof NotFoundError);
});
