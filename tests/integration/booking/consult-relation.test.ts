// Консультант по отношению booked_with_me (D-246): записывает клиента своей БК к себе — и только так.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { getConsultStrip } from '../../../src/server/domain/booking/consultDay';
import type { BookingDeps, IndividualBookingRequest } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, U } from '../../isolation/harness/seed';
import { SEED_NOW, addConsultant, closeConsultWorld, fakeCardPort, makeDeps, openConsultWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let cons: Viewer;
const clock = { now: SEED_NOW };

const ask = (clientId: string, resourceId: string | null, over: Partial<IndividualBookingRequest> = {}): IndividualBookingRequest => ({
  kind: 'individual',
  requestId: uuid(),
  clientId,
  eventTypeKey: 'bk',
  date: '2026-11-03',
  time: '10:30',
  directionKey: 'marketing',
  resourceId,
  contactId: null,
  ...over,
});
const notFound = (e: unknown) => e instanceof NotFoundError;
const countFor = async (clientId: string) => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${clientId} AND request_id IS NOT NULL`)[0]!.n;

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  cons = await viewerOf(U.consultant);
  await db.sql`UPDATE resources SET active = TRUE WHERE id IN ('rs-cons', 'rs-rop')`;
  await addConsultant(db.sql, { id: 'other', userId: U.marketer });
});
after(() => closeConsultWorld(db));

test('клиент своей БК в окне: запись к себе проходит, колокол себе не шлётся', async () => {
  const r = await createBooking(deps, cons, ask(FX.bkInWindow.client, 'rs-cons'));
  assert.equal(r.action, 'created');
  assert.deepEqual([r.booking.resourceId, r.booking.bookedByUserId], ['rs-cons', U.consultant]);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE entity_id = ${r.booking.id}`)[0]!.n, 0);
});

test('к другому консультанту, «серая», групповая, клиент вне окна и чужой клиент — 404 без изменений', async () => {
  const before = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings`)[0]!.n;
  await assert.rejects(createBooking(deps, cons, ask(FX.bkInWindow.client, 'other', { time: '12:00' })), notFound);
  await assert.rejects(createBooking(deps, cons, ask(FX.bkInWindow.client, 'rs-rop', { time: '12:00' })), notFound);
  await assert.rejects(createBooking(deps, cons, ask(FX.bkInWindow.client, null, { time: '12:00' })), notFound);
  await assert.rejects(createBooking(deps, cons, { kind: 'group', requestId: uuid(), clientId: FX.bkInWindow.client, eventId: 'ev-tomorrow', contactId: null }), notFound);
  for (const client of [FX.bkFuture.client, FX.bkPast.client, 'cl-a-1', 'cl-b-30']) {
    await assert.rejects(createBooking(deps, cons, ask(client, 'rs-cons', { time: '12:00' })), notFound, client);
    assert.equal(await countFor(client), 0);
  }
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings`)[0]!.n, before);
});

test('полоса подбора консультанта: только он сам, «Назначим утром» недоступно; карточка вне окна — 404', async () => {
  const strip = await getConsultStrip(deps, cons, { cardId: FX.bkInWindow.card, eventTypeKey: 'bk', directionKey: 'marketing' });
  assert.ok(strip.days.length > 0);
  for (const day of strip.days) {
    for (const slot of day.slots) {
      assert.equal(slot.greyAllowed, false);
      assert.deepEqual([slot.suggested?.resourceId, ...slot.others.map((o) => o.resourceId)], ['rs-cons']);
    }
  }
  await assert.rejects(getConsultStrip(deps, cons, { cardId: FX.bkFuture.card, eventTypeKey: 'bk', directionKey: 'marketing' }), notFound);
});

test('без флага BK_WIZARD консультант не записывает и по отношению', async () => {
  process.env['FEATURE_BK_WIZARD'] = '0';
  try {
    await assert.rejects(createBooking(deps, cons, ask(FX.bkInWindow.client, 'rs-cons', { time: '13:30' })), notFound);
  } finally {
    process.env['FEATURE_BK_WIZARD'] = '1';
  }
});
