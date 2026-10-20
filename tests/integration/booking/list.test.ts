// Минимальные «Записи» (B3a, §8): охват записи, название клиента, признак «серой», отменённые не в списке.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { cancelBooking, createBooking } from '../../../src/server/domain/booking/bookings';
import { listBookingItems } from '../../../src/server/domain/booking/list';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;
const window = { from: '2026-10-28', to: '2026-11-25', status: ['registered', 'confirmed'] as const };

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'ls-1', date: '2026-11-05', time: '15:00' });
  await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-50', eventId: 'ls-1', contactId: null });
  await createBooking(deps, opA, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-51', eventTypeKey: 'bk', date: '2026-10-29', time: '09:45', directionKey: 'marketing', resourceId: null, contactId: null });
  await createBooking(deps, opB, { kind: 'group', requestId: uuid(), clientId: 'cl-b-50', eventId: 'ls-1', contactId: null });
  const cancelled = await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-52', eventId: 'ls-1', contactId: null });
  await cancelBooking(deps, opA, { bookingId: cancelled.booking.id, opId: uuid(), version: 0, reason: 'client' });
});
after(() => closeWorld(db));

test('оператор видит только своих: названия клиентов, серая заявка помечена, по времени начала', async () => {
  const items = await listBookingItems(deps, opA, window);
  assert.deepEqual(items.map((i) => [i.clientId, i.grey]), [['cl-a-51', true], ['cl-a-50', false]]);
  assert.ok(items.every((i) => i.clientName.length > 0));
  assert.ok(!items.some((i) => i.clientId.startsWith('cl-b-')), 'чужие не видны');
});

test('РОП видит всех, отменённые не в списке', async () => {
  const items = await listBookingItems(deps, rop, window);
  const ids = new Set(items.map((i) => i.clientId));
  for (const mine of ['cl-a-50', 'cl-a-51', 'cl-b-50']) assert.ok(ids.has(mine), mine);
  assert.ok(!ids.has('cl-a-52'), 'отменённая запись не в списке');
  assert.ok(items.length > 3, 'видны и записи из синтетики мира');
});

test('окно: пустое вне диапазона, неверные даты — 400', async () => {
  assert.deepEqual(await listBookingItems(deps, opA, { from: '2027-01-01', to: '2027-01-31' }), []);
  await assert.rejects(listBookingItems(deps, opA, { from: '2026-11-05', to: '2026-10-01' }), (e: unknown) => (e as Error).message === 'bad_request' || /bad_request/.test(String(e)));
});
