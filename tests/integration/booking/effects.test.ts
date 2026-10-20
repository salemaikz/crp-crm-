// Эффекты записей для исполнителя карточки (§7.2): cancel_future отменяет только будущие активные записи,
// reassign_future меняет ответственного и не трогает заслугу.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { systemActor } from '../../../src/server/access/systemActor';
import { applyBookingEffects } from '../../../src/server/domain/booking/effects';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, SPACE } from '../../isolation/harness/seed';
import { SEED_NOW, closeWorld, openBookingWorld, seedBookings, seedEvent, viewerOf } from './helpers';

let db: TestDb;
let rop: Viewer;

before(async () => {
  db = await openBookingWorld();
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'f1', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'f2', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'f3', date: '2026-11-12', time: '15:00' });
  await seedEvent(db.sql, { id: 'f-old', date: '2026-10-26', time: '15:00' });
});
after(() => closeWorld(db));

const card = (n: number) => ({ id: `cd-a-${n}`, clientId: `cl-a-${n}`, spaceId: SPACE });
const one = (n: number) => [{ client: `cl-a-${n}`, card: `cd-a-${n}` }];
const statusesOf = async (n: number) =>
  (await db.sql<{ eventId: string; status: string; cancelReason: string; version: number }>`SELECT event_id, status, cancel_reason, version FROM bookings WHERE client_id = ${`cl-a-${n}`} ORDER BY event_id`).map(
    (r) => `${r.eventId}:${r.status}:${r.cancelReason}:${r.version}`,
  );

test('cancel_future do_not_call: только будущие активные записи; прошедшие и посетившие не тронуты', async () => {
  await seedBookings(db.sql, 'f1', one(1), { bookedBy: U.opA });
  await seedBookings(db.sql, 'f2', one(1), { status: 'confirmed', bookedBy: U.opA });
  await seedBookings(db.sql, 'f3', one(1), { status: 'attended', bookedBy: U.opA });
  await seedBookings(db.sql, 'f-old', one(1), { bookedBy: U.opA }); // прошедшая, не отмечена
  await db.tx((tx) => applyBookingEffects(tx, systemActor('test', SEED_NOW), card(1), [{ op: 'cancel_future', reason: 'do_not_call' }], SEED_NOW));
  assert.deepEqual(await statusesOf(1), ['f-old:registered::0', 'f1:cancelled:do_not_call:1', 'f2:cancelled:do_not_call:1', 'f3:attended::0']);

  const hist = await db.sql<{ action: string; toStatus: string; meta: { reason: string; via: string } }>`
    SELECT action, to_status, meta FROM booking_history WHERE booking_id IN (SELECT id FROM bookings WHERE client_id = 'cl-a-1') ORDER BY booking_id`;
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.action === 'cancelled' && h.toStatus === 'cancelled' && h.meta.reason === 'do_not_call' && h.meta.via === 'card_effect'));
  const feed = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE client_id = 'cl-a-1' AND kind = 'booking.status'`;
  assert.equal(feed[0]?.n, 2);

  // повторный вызов: активных будущих больше нет — ничего не меняется
  await db.tx((tx) => applyBookingEffects(tx, systemActor('test', SEED_NOW), card(1), [{ op: 'cancel_future', reason: 'do_not_call' }], SEED_NOW));
  assert.equal((await statusesOf(1)).length, 4);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM booking_history WHERE booking_id IN (SELECT id FROM bookings WHERE client_id = 'cl-a-1')`)[0]?.n, 2);
});

test('cancel_future not_target (после M1): причина записывается; записи других клиентов не затронуты', async () => {
  // M1 (docs/booking-design.md §12) оформляет координатор; здесь — тот же идемпотентный текст, чтобы проверить эффект
  await db.exec(`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancel_reason_check;
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_reason_check CHECK (cancel_reason IN ('','client','event_cancelled','operator_error','do_not_call','not_target'))`);
  await seedBookings(db.sql, 'f1', one(2), { bookedBy: U.opA });
  await seedBookings(db.sql, 'f1', one(3), { bookedBy: U.opA });
  await db.tx((tx) => applyBookingEffects(tx, rop, card(2), [{ op: 'cancel_future', reason: 'not_target' }], SEED_NOW));
  assert.deepEqual(await statusesOf(2), ['f1:cancelled:not_target:1']);
  assert.deepEqual(await statusesOf(3), ['f1:registered::0']);
});

test('reassign_future: меняется ответственный, заслуга остаётся; прошедшие записи не меняются', async () => {
  await seedBookings(db.sql, 'f1', one(4), { bookedBy: U.opA });
  await seedBookings(db.sql, 'f2', one(4), { bookedBy: U.opA });
  await seedBookings(db.sql, 'f-old', one(4), { bookedBy: U.opA });
  await db.tx((tx) => applyBookingEffects(tx, rop, card(4), [{ op: 'reassign_future', to: U.opB }], SEED_NOW));
  const rows = await db.sql<{ eventId: string; responsible: string; bookedBy: string; version: number }>`
    SELECT event_id, responsible_user_id AS responsible, booked_by_user_id AS booked_by, version FROM bookings WHERE client_id = 'cl-a-4' ORDER BY event_id`;
  assert.deepEqual(rows.map((r) => [r.eventId, r.responsible, r.bookedBy, r.version]), [
    ['f-old', U.opA, U.opA, 0],
    ['f1', U.opB, U.opA, 0],
    ['f2', U.opB, U.opA, 0],
  ]);
});
