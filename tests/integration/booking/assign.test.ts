// Назначение и переназначение консультанта (B5b, §4.7): ранг, графики, идемпотентность, резерв старого слота, права.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { assignConsultant, listAssignCandidates } from '../../../src/server/domain/booking/assign';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, insertGrey, makeDeps, openConsultWorld, uuid, viewerOf, weekdays } from './helpers';

const DAY = '2026-11-03';
let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let opA: Viewer;
const clock = { now: SEED_NOW };

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const view = async (id: string) => (await db.sql<{ resourceId: string | null; isReserve: boolean; durationMin: number; version: number }>`SELECT resource_id, is_reserve, duration_min, version FROM bookings WHERE id = ${id}`)[0]!;
const notes = (id: string) => db.sql<{ userId: string; kind: string; dedupeKey: string }>`SELECT user_id, kind, dedupe_key FROM notifications WHERE entity_id = ${id} ORDER BY kind, user_id`;
const history = (id: string, action: string) => db.sql<{ id: string; actorId: string | null; meta: Record<string, unknown> }>`SELECT id, actor_id, meta FROM booking_history WHERE booking_id = ${id} AND action = ${action}`;

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  await addConsultant(db.sql, { id: 'c1', userId: U.marketer, directions: ['marketing'], capacity: 2, sort: 1 });
  await addConsultant(db.sql, { id: 'c2', userId: U.mktHead, directions: ['consulting'], sort: 2 });
  await addSchedule(db.sql, 'c1', weekdays('09:00', '13:30'));
  await addSchedule(db.sql, 'c2', weekdays('09:00', '17:30'));
});
after(() => closeConsultWorld(db));

test('назначение «серой»: консультант, длительность = слот, история и лента, задача закрыта, колокола консультанту и автору', async () => {
  await insertGrey(db.sql, { id: 'g1', client: 'cl-a-60', card: 'cd-a-60', date: DAY, time: '10:30' });
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, source_key, created_at)
    VALUES (${uuid()}, 'sp-sales', 'cl-a-60', 'check', 'grey_unassigned', '', 'grey_unassigned:g1', ${SEED_NOW})`;
  const opId = uuid();
  const out = await assignConsultant(deps, rop, { bookingId: 'g1', opId, version: 0, resourceId: 'c1' });
  assert.deepEqual([out.resourceId, out.isReserve, out.durationMin, out.version], ['c1', false, 45, 1]);
  const h = await history('g1', 'assigned');
  assert.deepEqual(h.map((x) => [x.id, x.actorId, x.meta.resourceId]), [[opId, U.rop, 'c1']]);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'booking.assigned' AND ref_id = 'g1'`)[0]!.n, 1);
  assert.deepEqual((await db.sql<{ status: string }>`SELECT status FROM tasks WHERE source_key = 'grey_unassigned:g1'`).map((t) => t.status), ['done']);
  assert.deepEqual((await notes('g1')).map((n) => [n.userId, n.kind, n.dedupeKey]), [
    [U.marketer, 'booking_consult_new', 'consult_new:g1:c1'],
    [U.opA, 'consultant_assigned', 'assigned:g1:c1'],
  ]);
  // повтор opId: ни второго колокола, ни второй истории, ни роста версии
  const again = await assignConsultant(deps, rop, { bookingId: 'g1', opId, version: 0, resourceId: 'c1' });
  assert.equal(again.version, 1);
  assert.equal((await notes('g1')).length, 2);
  assert.equal((await history('g1', 'assigned')).length, 1);
  // тот же opId на другой записи — request_reused
  await insertGrey(db.sql, { id: 'g1b', client: 'cl-a-61', card: 'cd-a-61', date: DAY, time: '10:30' });
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'g1b', opId, version: 0, resourceId: 'c1' }), failsWith('request_reused'));
});

test('кандидат вне графика — slot_taken; устаревшая версия — 409; выключенный и неизвестный консультант', async () => {
  await insertGrey(db.sql, { id: 'g2', client: 'cl-a-62', card: 'cd-a-62', date: DAY, time: '15:00' });
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'g2', opId: uuid(), version: 0, resourceId: 'c1' }), failsWith('slot_taken'));
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'g2', opId: uuid(), version: 7, resourceId: 'c2' }), (e: unknown) => e instanceof ConflictError);
  await addConsultant(db.sql, { id: 'c-off', userId: U.duty, active: false });
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'g2', opId: uuid(), version: 0, resourceId: 'c-off' }), failsWith('consultant_inactive'));
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'g2', opId: uuid(), version: 0, resourceId: 'нет' }), failsWith('consultant_not_found'));
  assert.equal((await view('g2')).resourceId, null);
  const ok = await assignConsultant(deps, rop, { bookingId: 'g2', opId: uuid(), version: 0, resourceId: 'c2' });
  assert.equal(ok.resourceId, 'c2');
});

test('переназначение: слот прежнего консультанта освобождается, самый старый резерв становится основной записью', async () => {
  await insertGrey(db.sql, { id: 'main', client: 'cl-a-63', card: 'cd-a-63', date: DAY, time: '11:15', resourceId: 'c1', createdAt: SEED_NOW - 2000 });
  await insertGrey(db.sql, { id: 'res', client: 'cl-a-64', card: 'cd-a-64', date: DAY, time: '11:15', resourceId: 'c1', createdAt: SEED_NOW - 1000 });
  await db.sql`UPDATE bookings SET is_reserve = TRUE WHERE id = 'res'`;
  await assignConsultant(deps, rop, { bookingId: 'main', opId: uuid(), version: 0, resourceId: 'c2' });
  assert.equal((await view('main')).resourceId, 'c2');
  assert.equal((await view('res')).isReserve, false);
  assert.deepEqual((await history('res', 'promoted')).map((h) => h.meta.resourceId), ['c1']);
  assert.deepEqual((await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'reserve_promoted' AND entity_id = 'res' ORDER BY user_id`).map((n) => n.userId).sort(), [U.marketer, U.opA].sort());
});

test('кандидаты: ранг по направлению, потом по порядку; вне графика отсеяны', async () => {
  await insertGrey(db.sql, { id: 'g3', client: 'cl-a-65', card: 'cd-a-65', date: DAY, time: '09:45', direction: 'marketing' });
  const list = await listAssignCandidates(deps, rop, 'g3');
  assert.deepEqual(list.map((c) => [c.resourceId, c.directionMatch]), [['c1', true], ['c2', false]]);
  await insertGrey(db.sql, { id: 'g4', client: 'cl-a-66', card: 'cd-a-66', date: DAY, time: '16:30', direction: 'marketing' });
  assert.deepEqual((await listAssignCandidates(deps, rop, 'g4')).map((c) => c.resourceId), ['c2']);
});

test('права: оператор — 404; групповая запись — not_an_individual_event; без флага достаточно активного консультанта', async () => {
  await insertGrey(db.sql, { id: 'g5', client: 'cl-a-67', card: 'cd-a-67', date: DAY, time: '16:30' });
  await assert.rejects(assignConsultant(deps, opA, { bookingId: 'g5', opId: uuid(), version: 0, resourceId: 'c2' }), (e: unknown) => e instanceof NotFoundError);
  await assert.rejects(assignConsultant(deps, rop, { bookingId: 'bk-guest-tomorrow', opId: uuid(), version: 0, resourceId: 'c2' }), failsWith('not_an_individual_event'));
  process.env['FEATURE_BK_WIZARD'] = '0';
  try {
    // 16:30 вне графика c1, но без флага снимка нет — ручное назначение работает (D-203)
    const out = await assignConsultant(deps, rop, { bookingId: 'g5', opId: uuid(), version: 0, resourceId: 'c1' });
    assert.equal(out.resourceId, 'c1');
    assert.equal((await listAssignCandidates(deps, rop, 'g5')).length, 2);
  } finally {
    process.env['FEATURE_BK_WIZARD'] = '1';
  }
});
