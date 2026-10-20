// Мастер внутри итога (путь A, calls-design §4.3): заявка на консультацию уходит вместе с итогом одной
// транзакцией; отказ записи откатывает итог; гонка за место — альтернативы и повтор тем же opId.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { seedBookings, seedEvent } from './helpers';
import { SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };

const fresh = (id: string) => setCard(db.sql, id, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
const consultReq = (cardId: string, over: Record<string, unknown> = {}) =>
  outcomeReq({
    cardId,
    outcomeKey: 'agreed',
    agreement: { contactId: null, agreedDueAt: null, booking: { kind: 'individual', eventTypeKey: 'bk', date: '2026-10-29', time: '10:30', directionKey: 'marketing', resourceId: null, ...over } },
  });

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ol-one', date: '2026-11-05', time: '15:00', capacity: 1 });
  await seedEvent(db.sql, { id: 'ol-two', date: '2026-11-12', time: '15:00' });
});
after(() => closeCallsWorld(db));

test('итог «Договорились» с заявкой на консультацию: calls, «серая» запись и сделка в одной транзакции', async () => {
  await fresh('cd-a-60');
  const req = consultReq('cd-a-60');
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.equal(r.card?.state, 'agreed');
  assert.ok(r.bookingId);
  const [b] = await db.sql<{ id: string; kind: string; resourceId: string | null; eventId: string | null; requestId: string; dealId: string | null }>`SELECT id, kind, resource_id, event_id, request_id, deal_id FROM bookings WHERE client_id = 'cl-a-60'`;
  assert.deepEqual([b!.id, b!.kind, b!.resourceId, b!.eventId, b!.requestId], [r.bookingId, 'individual', null, null, req.opId]);
  assert.ok(b!.dealId);
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${req.opId} AND applied = 'applied'`), 1);
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM deals WHERE card_id = 'cd-a-60'`), 1);
});

test('время вне сетки в итоге: 409 outside_hours, ни calls, ни записи, карточка прежняя', async () => {
  await fresh('cd-a-61');
  const req = consultReq('cd-a-61', { time: '10:00' });
  await assert.rejects(submitOutcome(deps, opA, req), (e: unknown) => e instanceof BookingDomainError && e.code === 'outside_hours' && e.status === 409);
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${req.opId}`), 0);
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-61'`), 0);
  assert.deepEqual([(await cardOf(db.sql, 'cd-a-61')).state, (await cardOf(db.sql, 'cd-a-61')).version], ['new', 0]);
});

test('групповая: event_full в итоге → 409 с альтернативами; повтор тем же opId на другое мероприятие → успех', async () => {
  await fresh('cd-a-62');
  await seedBookings(db.sql, 'ol-one', [{ client: 'cl-a-63', card: 'cd-a-63' }], { bookedBy: U.opA });
  const opId = outcomeReq({ cardId: 'cd-a-62' }).opId;
  const withEvent = (eventId: string) =>
    outcomeReq({ opId, cardId: 'cd-a-62', outcomeKey: 'agreed', agreement: { contactId: null, agreedDueAt: null, booking: { kind: 'group', eventId } } });
  await assert.rejects(submitOutcome(deps, opA, withEvent('ol-one')), (e: unknown) => {
    assert.ok(e instanceof BookingDomainError && e.code === 'event_full');
    assert.ok(e.alternatives && e.alternatives.some((a) => a.id === 'ol-two'), 'альтернативы содержат ближайшее с местами');
    return true;
  });
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${opId}`), 0);
  const ok = await submitOutcome(deps, opA, withEvent('ol-two'));
  assert.equal(ok.status, 'applied');
  assert.ok(ok.bookingId);
});
