// Гонки записи на консультации (B5b, D-245): блокировка дня держит один свободный слот одному.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps, IndividualBookingRequest } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, makeDeps, openConsultWorld, uuid, viewerOf, weekdays } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };

// 10 слотов в день при шаге 45 мин с 09:00 до 17:00
const TIMES = ['09:00', '09:45', '10:30', '11:15', '12:00', '12:45', '13:30', '14:15', '15:00', '15:45'];
const DAYS = ['2026-11-03', '2026-11-04'];

const ask = (clientId: string, date: string, time: string, resourceId: string | null): IndividualBookingRequest => ({
  kind: 'individual',
  requestId: uuid(),
  clientId,
  eventTypeKey: 'bk',
  date,
  time,
  directionKey: 'marketing',
  resourceId,
  contactId: null,
});
const code = (r: PromiseSettledResult<unknown>): string => (r.status === 'rejected' && r.reason instanceof BookingDomainError ? r.reason.code : r.status === 'rejected' ? `error:${String(r.reason)}` : 'ok');

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  await addConsultant(db.sql, { id: 'solo', userId: U.marketer, autoAssign: false, sort: 1 });
  await addConsultant(db.sql, { id: 'duo', userId: U.mktHead, autoAssign: false, capacity: 2, sort: 2 });
  await addConsultant(db.sql, { id: 'pool', userId: U.duty, autoAssign: true, sort: 3 });
  for (const id of ['solo', 'duo', 'pool']) await addSchedule(db.sql, id, weekdays('09:00', '17:30'));
});
after(() => closeConsultWorld(db));

test('два оператора на один свободный слот (вместимость 1), 20 раз: одна основная, вторая slot_taken', async () => {
  const slots = DAYS.flatMap((d) => TIMES.map((t) => [d, t] as const));
  assert.equal(slots.length, 20);
  for (const [i, [date, time]] of slots.entries()) {
    const results = await Promise.allSettled([
      createBooking(deps, opA, ask(`cl-a-${50 + i}`, date, time, 'solo')),
      createBooking(deps, opB, ask(`cl-b-${50 + i}`, date, time, 'solo')),
    ]);
    assert.deepEqual(results.map(code).sort(), ['ok', 'slot_taken'], `${date} ${time}`);
  }
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE resource_id = 'solo' AND is_reserve = FALSE`;
  assert.equal(n[0]!.n, 20);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE resource_id = 'solo' AND is_reserve`)[0]!.n, 0);
});

test('вместимость 2: обе проходят, ровно одна из них — резерв', async () => {
  for (const [i, time] of TIMES.entries()) {
    const date = '2026-11-05';
    const results = await Promise.allSettled([
      createBooking(deps, opA, ask(`cl-a-${80 + i}`, date, time, 'duo')),
      createBooking(deps, opB, ask(`cl-b-${80 + i}`, date, time, 'duo')),
    ]);
    assert.deepEqual(results.map(code), ['ok', 'ok'], time);
    const flags = await db.sql<{ isReserve: boolean }>`SELECT is_reserve FROM bookings WHERE resource_id = 'duo' AND booking_date = ${date} AND start_time = ${time}`;
    assert.deepEqual(flags.map((f) => f.isReserve).sort(), [false, true], time);
  }
});

test('«серая» и прямая запись на одно время при одном консультанте в пуле: проходит ровно одна', async () => {
  for (const [i, time] of TIMES.entries()) {
    const date = '2026-11-06';
    const results = await Promise.allSettled([
      createBooking(deps, opA, ask(`cl-a-${90 + i}`, date, time, null)),
      createBooking(deps, opB, ask(`cl-b-${90 + i}`, date, time, 'pool')),
    ]);
    const codes = results.map(code);
    assert.equal(codes.filter((c) => c === 'ok').length, 1, `${time}: ${codes.join(',')}`);
    assert.ok(codes.some((c) => c === 'pool_full' || c === 'slot_taken'), `${time}: ${codes.join(',')}`);
  }
});
