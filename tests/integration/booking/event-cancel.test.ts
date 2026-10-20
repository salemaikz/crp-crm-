// Отмена мероприятия каскадом (PROCESS 12.26, §5.4): 17 активных записей из 18, события карточек, идемпотентность,
// гонка отмены с записью на то же мероприятие.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { cancelEvent, offerEvents } from '../../../src/server/domain/booking/events';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let rop: Viewer;
const port = fakeCardPort();

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, port);
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'ev-c', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-d', date: '2026-11-12', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-keep', date: '2026-11-19', time: '15:00' });
});
after(() => closeWorld(db));

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;

test('каскад: 17 активных записей отменены, история и лента у каждой, порт — по карточкам «Договорились»', async () => {
  const all = clientsOf('a', 1, 18);
  const ids = await seedBookings(db.sql, 'ev-c', all);
  await db.sql`UPDATE bookings SET status = 'confirmed' WHERE id = ${ids[16]!}`;
  await db.sql`UPDATE bookings SET status = 'cancelled', cancel_reason = 'client' WHERE id = ${ids[17]!}`;
  await seedBookings(db.sql, 'ev-d', clientsOf('a', 5, 5)); // у a-5 есть ещё одна будущая запись
  await setCardState(db.sql, 'cd-a-6', 'callback'); // событие карточки не нужно

  port.reset();
  const opId = uuid();
  const r = await cancelEvent(deps, rop, { eventId: 'ev-c', opId });
  assert.equal(r.replayed, false);
  assert.equal(r.cancelledBookings, 17);
  assert.equal(r.event.status, 'cancelled');

  const rows = await db.sql<{ id: string; status: string; cancelReason: string; version: number }>`SELECT id, status, cancel_reason, version FROM bookings WHERE event_id = 'ev-c' ORDER BY id`;
  assert.equal(rows.length, 18);
  assert.equal(rows.filter((x) => x.status === 'cancelled' && x.cancelReason === 'event_cancelled').length, 17);
  const was = rows.find((x) => x.id === ids[17])!;
  assert.deepEqual([was.status, was.cancelReason, was.version], ['cancelled', 'client', 0], 'ранее отменённая не тронута');
  assert.ok(rows.filter((x) => x.id !== ids[17]).every((x) => x.version === 1));

  const hist = await db.sql<{ bookingId: string; meta: { opId: string; eventId: string } }>`SELECT booking_id, meta FROM booking_history WHERE action = 'event_cancelled'`;
  assert.equal(hist.length, 17);
  assert.ok(hist.every((h) => h.meta.opId === opId && h.meta.eventId === 'ev-c'));
  const feed = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'booking.status' AND data->>'reason' = 'event_cancelled'`;
  assert.equal(feed[0]?.n, 17);

  // порт: по карточкам в «Договорились» (16 из 17), у a-5 — другая будущая запись
  assert.equal(port.calls.length, 16);
  assert.ok(port.calls.every((c) => c.event.type === 'booking_cancelled' && c.event.reason === 'client' && c.event.opId === opId));
  const facts = new Map(port.calls.map((c) => [c.event.type === 'booking_cancelled' ? c.event.bookingId : '', c.event.type === 'booking_cancelled' && c.event.facts.hasOtherFutureBooking]));
  assert.equal(facts.get(ids[4]!), true);
  assert.equal([...facts.values()].filter(Boolean).length, 1);
  assert.ok(port.calls.every((c) => c.result.status === 'applied'));

  const audit = await db.sql<{ action: string; entity: string; entityId: string; meta: { count: number } }>`SELECT action, entity, entity_id, meta FROM audit_log WHERE entity_id = 'ev-c'`;
  assert.deepEqual(audit.map((a) => [a.action, a.entity, a.meta.count]), [['event.cancel', 'event', 17]]);
});

test('повтор отмены — replayed, ни одного изменения и события; запись на отменённое и мастер — отказ', async () => {
  const before = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM booking_history`;
  port.reset();
  const again = await cancelEvent(deps, rop, { eventId: 'ev-c', opId: uuid() });
  assert.equal(again.replayed, true);
  assert.equal(again.cancelledBookings, 0);
  assert.equal(port.calls.length, 0);
  assert.deepEqual((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM booking_history`)[0], before[0]);

  await assert.rejects(createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-40', eventId: 'ev-c', contactId: null }), failsWith('event_cancelled'));
  const offer = await offerEvents(deps, opA, { clientId: 'cl-a-40' });
  assert.ok(!offer.options.some((o) => o.id === 'ev-c'));
  assert.ok(offer.options.some((o) => o.id === 'ev-keep'));
});

test('отмена: оператор не может (403), прошедшее мероприятие и несуществующее — коды', async () => {
  await assert.rejects(cancelEvent(deps, opA, { eventId: 'ev-d', opId: uuid() }), (e: unknown) => e instanceof ForbiddenError);
  await seedEvent(db.sql, { id: 'ev-old', date: '2026-10-26', time: '15:00' });
  await assert.rejects(cancelEvent(deps, rop, { eventId: 'ev-old', opId: uuid() }), failsWith('event_in_past'));
  await assert.rejects(cancelEvent(deps, rop, { eventId: 'no-such', opId: uuid() }), failsWith('event_not_found'));
  const [row] = await db.sql<{ status: string }>`SELECT status FROM events WHERE id = 'ev-d'`;
  assert.equal(row?.status, 'scheduled');
});

test('гонка отмены и записи на то же мероприятие: запись либо отменена каскадом, либо получила event_cancelled', async () => {
  for (let i = 1; i <= 8; i++) {
    const ev = `ev-race-${i}`;
    await seedEvent(db.sql, { id: ev, date: `2026-12-${String(i).padStart(2, '0')}`, time: '15:00' });
    await seedBookings(db.sql, ev, clientsOf('a', 50 + i, 50 + i)); // уже записан один: у отмены есть карточка для блокировки
    const clients = clientsOf('b', 50 + 3 * i, 52 + 3 * i);
    const results = await Promise.allSettled([
      cancelEvent(deps, rop, { eventId: ev, opId: uuid() }),
      ...clients.map((c) => createBooking(deps, rop, { kind: 'group', requestId: uuid(), clientId: c.client, eventId: ev, contactId: null })),
    ]);
    for (const x of results) {
      if (x.status === 'rejected') assert.ok(failsWith('event_cancelled')(x.reason), `прогон ${i}: ${String((x.reason as Error)?.message)}`);
    }
    assert.equal(results[0]?.status, 'fulfilled', `прогон ${i}: отмена прошла`);
    const active = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${ev} AND status IN ('registered','confirmed')`;
    assert.equal(active[0]?.n, 0, `прогон ${i}: на отменённом мероприятии не осталось активных записей`);
    const [e] = await db.sql<{ status: string }>`SELECT status FROM events WHERE id = ${ev}`;
    assert.equal(e?.status, 'cancelled');
  }
});
