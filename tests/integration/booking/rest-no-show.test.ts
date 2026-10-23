// «Остальные не пришли» (B4, §2.5, D-242): массовая отметка одной транзакцией, повтор по состоянию, права дежурного.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { markRestNoShow } from '../../../src/server/domain/booking/duty';
import { markAttendance } from '../../../src/server/domain/booking/bookings';
import { cardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, SPACE, clientsOf, closeDutyWorld, fakeCardPort, makeDeps, openDutyWorld, seedBookings, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let duty: Viewer;
let opA: Viewer;
const port = fakeCardPort();
const clock = { now: SEED_NOW };

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const statuses = async (ids: string[]) => {
  const rows = await db.sql<{ id: string; status: string }>`SELECT id, status FROM bookings WHERE id = ANY(${ids}) ORDER BY id`;
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
};

before(async () => {
  db = await openDutyWorld();
  deps = makeDeps(clock, port);
  rop = await viewerOf(U.rop);
  duty = await viewerOf(U.duty);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ev-am', date: '2026-10-28', time: '09:00' }); // идёт сейчас (11:00)
  await seedEvent(db.sql, { id: 'ev-pm', date: '2026-10-28', time: '15:00' }); // ещё не началось
  await seedEvent(db.sql, { id: 'ev-old', date: '2026-10-27', time: '09:00' }); // вчера
  await seedEvent(db.sql, { id: 'ev-other', date: '2026-10-28', time: '09:30' }); // сегодня, дежурный не назначен
  for (const ev of ['ev-am', 'ev-pm', 'ev-old']) await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES (${ev}, ${U.duty}, ${SEED_NOW})`;
});
after(() => closeDutyWorld(db));

async function seedMarkTasks(bookingIds: string[], clients: Array<{ client: string }>): Promise<void> {
  for (const [i, id] of bookingIds.entries()) {
    for (const kind of ['marker', 'lead']) {
      await db.sql`
        INSERT INTO tasks (id, space_id, client_id, kind, source, title, source_key, created_at)
        VALUES (${`tk-mark-${id}-${kind}`}, ${SPACE}, ${clients[i]!.client}, 'check', 'attendance_mark', '', ${`attendance_mark:${id}:${kind}`}, ${SEED_NOW})`;
    }
  }
}

test('до начала мероприятия — too_early, ничего не меняется', async () => {
  const guests = clientsOf('a', 1, 2);
  const ids = await seedBookings(db.sql, 'ev-pm', guests, { bookedBy: U.opA });
  port.reset();
  await assert.rejects(markRestNoShow(deps, duty, { eventId: 'ev-pm', opId: uuid(), bookingIds: ids }), failsWith('too_early'));
  assert.deepEqual(Object.values(await statuses(ids)), ['registered', 'registered']);
  assert.equal(port.calls.length, 0);
});

test('5 гостей: двое отмечены, трое нет — «Остальные» ставит «Не пришёл» трём, порт и история, задачи закрыты', async () => {
  const guests = clientsOf('a', 11, 15);
  const ids = await seedBookings(db.sql, 'ev-am', guests, { bookedBy: U.opA });
  await seedMarkTasks(ids, guests);
  await markAttendance(deps, duty, { bookingId: ids[0]!, opId: uuid(), version: 0, to: 'attended' });
  await markAttendance(deps, rop, { bookingId: ids[1]!, opId: uuid(), version: 0, to: 'attended' });
  port.reset();

  const rest = ids.slice(2);
  const opId = uuid();
  const r = await markRestNoShow(deps, duty, { eventId: 'ev-am', opId, bookingIds: rest });
  assert.deepEqual(r, { marked: 3, skipped: 0 });
  const st = await statuses(ids);
  assert.deepEqual(ids.map((id) => st[id]), ['attended', 'attended', 'no_show', 'no_show', 'no_show']);

  assert.equal(port.calls.length, 3);
  assert.ok(port.calls.every((c) => c.event.type === 'no_show' && c.state === 'agreed' && c.result.status === 'applied'));
  const hist = await db.sql<{ bookingId: string; fromStatus: string; toStatus: string; meta: { bulk: boolean; opId: string } }>`
    SELECT booking_id, from_status, to_status, meta FROM booking_history WHERE booking_id = ANY(${rest}) AND to_status = 'no_show'`;
  assert.equal(hist.length, 3);
  assert.ok(hist.every((h) => h.fromStatus === 'registered' && h.meta.bulk === true && h.meta.opId === opId));
  const feed = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'booking.status' AND data->>'reason' = 'bulk'`;
  assert.equal(feed[0]?.n, 3);
  const open = await db.sql<{ sourceKey: string }>`SELECT source_key FROM tasks WHERE source = 'attendance_mark' AND status = 'open'`;
  // Явка закрывает задачи «Отметьте явку» этой записи, и ручная, и массовая (§3.4)
  assert.equal(open.length, 0, 'у всех пяти отмеченных задач «Отметьте явку» закрыты');

  // повтор того же тела — по состоянию: ничего не меняется
  port.reset();
  const again = await markRestNoShow(deps, duty, { eventId: 'ev-am', opId, bookingIds: rest });
  assert.deepEqual(again, { marked: 0, skipped: 3 });
  assert.equal(port.calls.length, 0);
});

test('запись, отмеченная «Пришёл» между загрузкой экрана и нажатием, не тронута; чужое мероприятие и неизвестный id — skipped', async () => {
  const guests = clientsOf('a', 21, 23);
  const ids = await seedBookings(db.sql, 'ev-am', guests, { bookedBy: U.opA });
  const foreign = await seedBookings(db.sql, 'ev-other', clientsOf('a', 24, 24), { bookedBy: U.opA });
  await markAttendance(deps, duty, { bookingId: ids[2]!, opId: uuid(), version: 0, to: 'attended' });
  const r = await markRestNoShow(deps, duty, { eventId: 'ev-am', opId: uuid(), bookingIds: [...ids, ...foreign, uuid()] });
  assert.deepEqual(r, { marked: 2, skipped: 3 });
  const st = await statuses([...ids, ...foreign]);
  assert.deepEqual([st[ids[0]!], st[ids[1]!], st[ids[2]!], st[foreign[0]!]], ['no_show', 'no_show', 'attended', 'registered']);
});

test('РОП отмечает любое сегодняшнее мероприятие; оператор без дежурства и дежурный чужого мероприятия — 404', async () => {
  const ids = await seedBookings(db.sql, 'ev-other', clientsOf('a', 31, 32), { bookedBy: U.opA });
  await assert.rejects(markRestNoShow(deps, duty, { eventId: 'ev-other', opId: uuid(), bookingIds: ids }), failsWith('event_not_found'));
  await assert.rejects(markRestNoShow(deps, opA, { eventId: 'ev-other', opId: uuid(), bookingIds: ids }), failsWith('event_not_found'));
  const r = await markRestNoShow(deps, rop, { eventId: 'ev-other', opId: uuid(), bookingIds: ids });
  assert.equal(r.marked, 2);
});

test('дежурный вчерашнего мероприятия — 404 (дежурство «сегодня» кончилось)', async () => {
  const ids = await seedBookings(db.sql, 'ev-old', clientsOf('a', 41, 41), { bookedBy: U.opA });
  clock.now = SEED_NOW;
  await assert.rejects(markRestNoShow(deps, duty, { eventId: 'ev-old', opId: uuid(), bookingIds: ids }), failsWith('event_not_found'));
  assert.equal((await statuses(ids))[ids[0]!], 'registered');
});

test('отменённое мероприятие — event_cancelled', async () => {
  await seedEvent(db.sql, { id: 'ev-x', date: '2026-10-28', time: '08:00', status: 'cancelled' });
  const ids = await seedBookings(db.sql, 'ev-x', clientsOf('a', 51, 51), { bookedBy: U.opA });
  await assert.rejects(markRestNoShow(deps, rop, { eventId: 'ev-x', opId: uuid(), bookingIds: ids }), failsWith('event_cancelled'));
});

test('карточка не в «Договорились»: «Остальные не пришли» пересчитывает кэш неявки (§5.1)', async () => {
  const guests = clientsOf('a', 61, 61);
  const ids = await seedBookings(db.sql, 'ev-am', guests, { bookedBy: U.opA });
  await db.sql`UPDATE cards SET state = 'client' WHERE client_id = ${guests[0]!.client}`;
  const withCache: BookingDeps = { ...deps, cards: { ...port, refreshDerived: cardBookingPort.refreshDerived } };
  const r = await markRestNoShow(withCache, duty, { eventId: 'ev-am', opId: uuid(), bookingIds: ids });
  assert.equal(r.marked, 1);
  const [c] = await db.sql<{ at: number | null; kind: string }>`SELECT last_no_show_at AS at, last_no_show_kind AS kind FROM cards WHERE client_id = ${guests[0]!.client}`;
  assert.notEqual(c!.at, null);
  assert.equal(c!.kind, 'group');
});
