// Гонка за последнее место (PROCESS 12.19, D-131): одна точка сериализации — блокировка мероприятия,
// занято считается отдельным запросом после неё. Проверка на живом Postgres, настоящие параллельные соединения.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { booking } from '../../../packages/core/src';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps, CreateBookingResult } from '../../../src/server/domain/booking/types';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

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
  await seedEvent(db.sql, { id: 'ev-spare', date: '2026-11-03', time: '15:00' });
});
after(() => closeWorld(db));

const req = (clientId: string, eventId: string, requestId = uuid()) => ({ kind: 'group' as const, requestId, clientId, eventId, contactId: null });
const taken = async (eventId: string) =>
  (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${eventId} AND status IN ('registered','confirmed','attended','no_show')`)[0]?.n;

type Settled = PromiseSettledResult<CreateBookingResult>;
const created = (r: Settled) => r.status === 'fulfilled';
const fullReason = (r: Settled) => (r.status === 'rejected' && r.reason instanceof BookingDomainError ? r.reason : null);

test('последнее место: два оператора, 20 прогонов — ровно одна запись, вторая event_full с альтернативами', async () => {
  for (let i = 1; i <= 20; i++) {
    const ev = `ev-last-${i}`;
    await seedEvent(db.sql, { id: ev, date: booking.addDays('2026-11-10', i), time: '15:00', capacity: 30 });
    await seedBookings(db.sql, ev, clientsOf('a', 1, 29));
    const [a, b] = await Promise.allSettled([
      createBooking(deps, opA, req(`cl-a-${30 + i}`, ev)),
      createBooking(deps, opB, req(`cl-b-${30 + i}`, ev)),
    ]);
    assert.equal([a, b].filter((r) => created(r!)).length, 1, `прогон ${i}: ровно одна запись`);
    const loser = fullReason(created(a!) ? b! : a!);
    assert.ok(loser, `прогон ${i}: вторая отклонена доменной ошибкой`);
    assert.equal(loser.code, 'event_full');
    assert.ok((loser.alternatives ?? []).some((o) => o.id === 'ev-spare' && o.seats.left === 30), 'альтернатива — мероприятие со свободными местами');
    assert.equal(await taken(ev), 30, `прогон ${i}: места не превышены`);
  }
});

test('вместимость 5, 12 одновременных записей разных клиентов — ровно 5', async () => {
  await seedEvent(db.sql, { id: 'ev-five', date: '2026-12-20', time: '15:00', capacity: 5 });
  const results = await Promise.allSettled(clientsOf('a', 60, 71).map((c) => createBooking(deps, rop, req(c.client, 'ev-five'))));
  assert.equal(results.filter(created).length, 5);
  const rejected = results.map(fullReason).filter((e) => e !== null);
  assert.equal(rejected.length, 7);
  assert.ok(rejected.every((e) => e.code === 'event_full'));
  assert.equal(await taken('ev-five'), 5);
});

test('один клиент, два разных ключа параллельно — одна запись, вторая already_registered', async () => {
  await seedEvent(db.sql, { id: 'ev-dup', date: '2026-12-21', time: '15:00' });
  const results = await Promise.allSettled([createBooking(deps, opA, req('cl-a-80', 'ev-dup')), createBooking(deps, rop, req('cl-a-80', 'ev-dup'))]);
  assert.equal(results.filter(created).length, 1);
  assert.equal(results.map(fullReason).find((e) => e)?.code, 'already_registered');
  assert.equal(await taken('ev-dup'), 1);
});

test('один ключ запроса параллельно — одна строка, второй ответ replayed', async () => {
  await seedEvent(db.sql, { id: 'ev-same-key', date: '2026-12-22', time: '15:00' });
  const requestId = uuid();
  const results = await Promise.all([
    createBooking(deps, opA, req('cl-a-81', 'ev-same-key', requestId)),
    createBooking(deps, opA, req('cl-a-81', 'ev-same-key', requestId)),
    createBooking(deps, opA, req('cl-a-81', 'ev-same-key', requestId)),
  ]);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(results.filter((r) => r.replayed).length, 2);
  assert.equal(new Set(results.map((r) => r.booking.id)).size, 1);
  assert.equal(await taken('ev-same-key'), 1);
});
