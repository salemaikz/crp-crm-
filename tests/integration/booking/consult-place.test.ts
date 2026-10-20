// Запись консультации за флагом BK_WIZARD (B5b, §4.6, D-245): к консультанту, резерв, slot_taken с альтернативами,
// «серая» и пул, задача РОП после последнего прогона, перенос и отмена освобождают слот и повышают резерв.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { booking } from '../../../packages/core/src';
import { NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { cancelBooking, createBooking } from '../../../src/server/domain/booking/bookings';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps, IndividualBookingRequest } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, SEED_TZ, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, makeDeps, openConsultWorld, setGreyConfig, uuid, viewerOf, weekdays } from './helpers';

// SEED_NOW — среда 2026-10-28 11:00 (Asia/Almaty); день записи — вторник 2026-11-03
const DAY = '2026-11-03';
let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };

const ask = (clientId: string, time: string, resourceId: string | null, over: Partial<IndividualBookingRequest> = {}): IndividualBookingRequest => ({
  kind: 'individual',
  requestId: uuid(),
  clientId,
  eventTypeKey: 'bk',
  date: DAY,
  time,
  directionKey: 'marketing',
  resourceId,
  contactId: null,
  ...over,
});
const row = async (id: string) => (await db.sql<{ resourceId: string | null; isReserve: boolean; durationMin: number; status: string }>`SELECT resource_id, is_reserve, duration_min, status FROM bookings WHERE id = ${id}`)[0]!;
const slotTaken = (e: unknown) => e instanceof BookingDomainError && e.code === 'slot_taken';
const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  opA = await viewerOf(U.opA);
  // c1 — основной (в пуле), c2 — вместимость 2, вне пула автоназначения
  await addConsultant(db.sql, { id: 'c1', userId: U.marketer, directions: ['marketing'], sort: 1 });
  await addConsultant(db.sql, { id: 'c2', userId: U.mktHead, directions: ['consulting'], capacity: 2, autoAssign: false, sort: 2 });
  await addSchedule(db.sql, 'c1', weekdays('09:00', '13:30'));
  await addSchedule(db.sql, 'c2', weekdays('09:00', '13:30'));
});
after(() => closeConsultWorld(db));

test('к консультанту в слот графика: resource_id, длительность = слот, колокол консультанту, история', async () => {
  const r = await createBooking(deps, opA, ask('cl-a-30', '09:00', 'c1'));
  assert.equal(r.action, 'created');
  const b = r.booking;
  assert.deepEqual([b.resourceId, b.isReserve, b.durationMin, b.status, b.startTime], ['c1', false, 45, 'registered', '09:00']);
  assert.equal(b.startsAt, booking.localToEpoch(SEED_TZ, DAY, '09:00'));
  const n = await db.sql<{ userId: string; kind: string; entityId: string; dedupeKey: string }>`SELECT user_id, kind, entity_id, dedupe_key FROM notifications WHERE entity_id = ${b.id}`;
  assert.deepEqual(n.map((x) => [x.userId, x.kind, x.dedupeKey]), [[U.marketer, 'booking_consult_new', `consult_new:${b.id}:c1`]]);
  // повтор ключа — тот же ответ, второго колокола нет
  const again = await createBooking(deps, opA, { ...ask('cl-a-30', '09:00', 'c1'), requestId: (await db.sql<{ requestId: string }>`SELECT request_id FROM bookings WHERE id = ${b.id}`)[0]!.requestId });
  assert.equal(again.replayed, true);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE entity_id = ${b.id}`)[0]!.n, 1);
});

test('вместимость 2: вторая запись — резерв, третья — slot_taken с тремя альтернативами из ранга', async () => {
  const main = await createBooking(deps, opA, ask('cl-a-31', '09:45', 'c2', { directionKey: 'consulting' }));
  const reserve = await createBooking(deps, opA, ask('cl-a-32', '09:45', 'c2', { directionKey: 'consulting' }));
  assert.equal(main.booking.isReserve, false);
  assert.equal(reserve.booking.isReserve, true);
  await assert.rejects(createBooking(deps, opA, ask('cl-a-33', '09:45', 'c2', { directionKey: 'consulting' })), (e: unknown) => {
    assert.ok(slotTaken(e));
    const alt = (e as BookingDomainError).suggestions ?? [];
    assert.deepEqual(alt.map((a) => a.resourceId), ['c1'], 'свободен только c1');
    return true;
  });
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-33'`)[0]!.n, 0);
});

test('вместимость 1: занятый слот — slot_taken; время вне графика — slot_taken; чужой и выключенный консультант — 404', async () => {
  await assert.rejects(createBooking(deps, opA, ask('cl-a-34', '09:00', 'c1')), slotTaken);
  await assert.rejects(createBooking(deps, opA, ask('cl-a-34', '09:10', 'c1')), slotTaken);
  await assert.rejects(createBooking(deps, opA, ask('cl-a-34', '09:00', 'нет-такого')), failsWith('consultant_not_found'));
  await addConsultant(db.sql, { id: 'c-off', userId: U.duty, active: false });
  await assert.rejects(createBooking(deps, opA, ask('cl-a-34', '09:00', 'c-off')), failsWith('consultant_not_found'));
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-34'`)[0]!.n, 0);
});

test('«серая»: пул вмещает одну, вторая на то же время — pool_full; прямая запись, отнимающая место у «серой», — slot_taken', async () => {
  const grey = await createBooking(deps, opA, ask('cl-a-35', '10:30', null));
  assert.deepEqual([grey.booking.resourceId, grey.booking.isReserve], [null, false]);
  await assert.rejects(createBooking(deps, opA, ask('cl-a-37', '10:30', null)), failsWith('pool_full'));
  // c1 — единственный в пуле: записать к нему напрямую значит оставить «серую» без консультанта
  await assert.rejects(createBooking(deps, opA, ask('cl-a-36', '10:30', 'c1')), slotTaken);
  // c2 вне пула — к нему можно
  const direct = await createBooking(deps, opA, ask('cl-a-36', '10:30', 'c2', { directionKey: 'consulting' }));
  assert.equal(direct.booking.resourceId, 'c2');
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-37'`)[0]!.n, 0);
});

test('«серая» после последнего прогона на сегодня: создаётся задача РОП grey_unassigned со сроком — начало записи', async () => {
  await addConsultant(db.sql, { id: 'c3', userId: U.opB, slotMin: 45, sort: 3 }); // без графика: работает по общим часам
  await setGreyConfig({ mode: 'assign', first: '09:00', last: '10:00', stepMin: 30 });
  clock.now = booking.localToEpoch(SEED_TZ, '2026-10-28', '10:30');
  try {
    const r = await createBooking(deps, opA, ask('cl-a-38', '17:15', null, { date: '2026-10-28' }));
    const tasks = await db.sql<{ source: string; kind: string; sourceKey: string; dueAt: number; assigneeUserId: string | null; clientId: string }>`
      SELECT source, kind, source_key, due_at, assignee_user_id, client_id FROM tasks WHERE source_key = ${`grey_unassigned:${r.booking.id}`}`;
    assert.equal(tasks.length, 1);
    assert.deepEqual([tasks[0]!.source, tasks[0]!.kind, tasks[0]!.clientId], ['grey_unassigned', 'check', 'cl-a-38']);
    assert.equal(tasks[0]!.dueAt, r.booking.startsAt);
    assert.ok(tasks[0]!.assigneeUserId, 'получатель — руководитель');
    // обычная «серая» до последнего прогона задачи не создаёт
    const early = await createBooking(deps, opA, ask('cl-a-39', '12:00', null));
    assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM tasks WHERE source_key = ${`grey_unassigned:${early.booking.id}`}`)[0]!.n, 0);
  } finally {
    clock.now = SEED_NOW;
    await setGreyConfig({ mode: 'assign' });
    await db.sql`UPDATE resources SET active = FALSE WHERE id = 'c3'`;
  }
});

test('флаг выключен: «серая» без проверки пула (как B3a), запись к консультанту — 404', async () => {
  process.env['FEATURE_BK_WIZARD'] = '0';
  try {
    // 10:30 в пуле уже занято «серой» cl-a-35, но без флага пул не смотрим
    const r = await createBooking(deps, opA, ask('cl-a-40', '10:30', null));
    assert.equal(r.booking.resourceId, null);
    await assert.rejects(createBooking(deps, opA, ask('cl-a-41', '09:45', 'c1')), (e: unknown) => e instanceof NotFoundError);
  } finally {
    process.env['FEATURE_BK_WIZARD'] = '1';
  }
});

test('отмена основной записи повышает резерв: флаг, история promoted, колокол консультанту и ответственному', async () => {
  const main = await createBooking(deps, opA, ask('cl-a-42', '12:00', 'c2', { directionKey: 'consulting' }));
  const res = await createBooking(deps, opA, ask('cl-a-43', '12:00', 'c2', { directionKey: 'consulting' }));
  assert.equal(res.booking.isReserve, true);
  await cancelBooking(deps, opA, { bookingId: main.booking.id, opId: uuid(), version: main.booking.version, reason: 'client' });
  assert.equal((await row(res.booking.id)).isReserve, false);
  const hist = await db.sql<{ action: string }>`SELECT action FROM booking_history WHERE booking_id = ${res.booking.id} ORDER BY created_at, id`;
  assert.deepEqual(hist.map((h) => h.action).sort(), ['created', 'promoted']);
  const n = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'reserve_promoted' AND entity_id = ${res.booking.id} ORDER BY user_id`;
  assert.deepEqual(n.map((x) => x.userId).sort(), [U.mktHead, U.opA].sort());
});

test('перенос консультации (тот же вид): старая запись — moved, её место отдаётся резерву', async () => {
  const main = await createBooking(deps, opA, ask('cl-a-44', '12:45', 'c2', { directionKey: 'consulting' }));
  const res = await createBooking(deps, opA, ask('cl-a-45', '12:45', 'c2', { directionKey: 'consulting' }));
  assert.equal(res.booking.isReserve, true);
  const moved = await createBooking(deps, opA, ask('cl-a-44', '11:15', 'c1'));
  assert.equal(moved.action, 'moved');
  assert.equal((await row(main.booking.id)).status, 'moved');
  assert.equal((await row(res.booking.id)).isReserve, false, 'резерв стал основной записью');
  assert.equal((await row(moved.booking.id)).resourceId, 'c1');
});

test('отмена «серой» закрывает задачу «Назначьте консультанта»', async () => {
  const grey = await createBooking(deps, opA, ask('cl-a-46', '12:45', null));
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, source_key, created_at)
    VALUES (${uuid()}, 'sp-sales', 'cl-a-46', 'check', 'grey_unassigned', '', ${`grey_unassigned:${grey.booking.id}`}, ${SEED_NOW})`;
  await cancelBooking(deps, opA, { bookingId: grey.booking.id, opId: uuid(), version: grey.booking.version, reason: 'client' });
  const t = await db.sql<{ status: string }>`SELECT status FROM tasks WHERE source_key = ${`grey_unassigned:${grey.booking.id}`}`;
  assert.deepEqual(t.map((x) => x.status), ['done']);
});
