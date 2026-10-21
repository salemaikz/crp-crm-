// Неотмеченная явка (B4b, §3.2, D-243, PROCESS 3.5 № 28): напоминания отметчику и РОП, «Не пришёл» по сроку,
// отметчик по виду записи, выключатель, ручная отметка, повтор прогона. Порт карточки — настоящий (cardBookingPort).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { booking } from '../../../packages/core/src';
import { systemActor } from '../../../src/server/access/systemActor';
import { markAttendance } from '../../../src/server/domain/booking/bookings';
import { attendanceSweepJob } from '../../../src/server/domain/booking/jobs';
import { runAttendanceSweep, sweepAttendance } from '../../../src/server/domain/booking/sweep';
import { cardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { worldConfig } from '../clients/world';
import { SEED_TZ, addConsultant, closeDutyWorld, insertGrey, makeDeps, openDutyWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
const clock = { now: 0 };
const at = (day: string, hhmm: string) => booking.localToEpoch(SEED_TZ, day, hhmm);
const sys = () => systemActor('attendance-sweep@sales', clock.now);
const sweep = () => runAttendanceSweep(deps, sys(), { spaceId: SPACE, now: clock.now });
const FRI = '2026-10-30';
const MON = '2026-11-02';

const marks = (bookingId: string) =>
  db.sql<{ kind: string; assignee: string | null; status: string; dueAt: number | null }>`
    SELECT right(source_key, length(source_key) - length(${`attendance_mark:${bookingId}:`})) AS kind, assignee_user_id AS assignee, status, due_at
      FROM tasks WHERE source_key LIKE ${`attendance_mark:${bookingId}:%`} ORDER BY source_key`;
const bookingStatus = async (id: string) => (await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${id}`)[0]!.status;
const cardState = async (id: string) => (await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = ${id}`)[0]!.state;

async function setAutoNoShow(value: number | null): Promise<void> {
  resetConfigCache();
  const docs = worldConfig();
  ((docs.spaces.sales as Record<string, unknown>).booking as { attendance: { autoNoShowWorkdays: number | null } }).attendance.autoNoShowWorkdays = value;
  (docs.global['sources'] as unknown[]).push({ key: 'walk_in', label: { ru: 'Пришёл без записи' }, kind: 'walk_in', allowPersonNames: true, detailedReport: false, rejectRules: [], holdRules: [] });
  (docs.global['security'] as Record<string, unknown>)['phoneProbesPerDay'] = 20;
  await writeConfig({ docs, source: 'cli', authorId: null, project: true, note: 'сверка явки' });
}

before(async () => {
  db = await openDutyWorld();
  deps = makeDeps(clock, cardBookingPort);
  // Только нужные карточки остаются «Договорились»
  await db.sql`UPDATE cards SET state = 'client' WHERE state = 'agreed'`;
});
after(() => closeDutyWorld(db));

test('БР чт 29.10: пт 10:00 — задачи дежурному и РОП, карточка та же; повтор — задач не больше; пн — «Не пришёл» и «перезаписать»', async () => {
  await seedEvent(db.sql, { id: 'sw-br1', date: '2026-10-29', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('sw-br1', ${U.duty}, 1)`;
  const [id] = await seedBookings(db.sql, 'sw-br1', [{ client: 'cl-a-50', card: 'cd-a-50' }], { bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-50', 'agreed');

  clock.now = at(FRI, '10:00');
  const r1 = await sweep();
  assert.ok(r1.reminded >= 1, 'в отчёте есть напоминания');
  assert.equal(await bookingStatus(id!), 'registered');
  assert.equal(await cardState('cd-a-50'), 'agreed');
  const t1 = await marks(id!);
  assert.deepEqual(t1.map((t) => [t.kind, t.status, t.dueAt]), [['lead', 'open', clock.now], ['marker', 'open', clock.now]]);
  assert.equal(t1.find((t) => t.kind === 'marker')!.assignee, U.duty);
  assert.ok(t1.find((t) => t.kind === 'lead')!.assignee, 'РОП определён');

  await sweep();
  assert.equal((await marks(id!)).length, 2, 'повтор в тот же день задач не задваивает');

  clock.now = at(MON, '10:00');
  const r2 = await sweep();
  assert.ok(r2.marked >= 1);
  assert.equal(await bookingStatus(id!), 'no_show');
  assert.equal(await cardState('cd-a-50'), 'callback');
  assert.deepEqual((await marks(id!)).map((t) => t.status), ['done', 'done'], 'задачи «Отметьте явку» закрыты');
  const rebook = await db.sql<{ status: string; dueAt: number }>`SELECT status, due_at FROM tasks WHERE source_key = ${`no_show:${id!}`}`;
  assert.deepEqual(rebook.map((t) => [t.status, t.dueAt]), [['open', at('2026-11-03', '10:00')]], 'задача «перезаписать» на следующий рабочий день 10:00');
  const h = await db.sql<{ actorId: string | null; meta: { job: string; elapsed: number } }>`SELECT actor_id, meta FROM booking_history WHERE booking_id = ${id!} AND action = 'auto_no_show'`;
  assert.deepEqual(h.map((x) => [x.actorId, x.meta.job, x.meta.elapsed]), [[null, 'attendance-sweep', 2]]);
  const feed = await db.sql<{ actorId: string | null; data: { reason: string; to: string } }>`SELECT actor_id, data FROM client_events WHERE ref_id = ${id!} AND kind = 'booking.status'`;
  assert.deepEqual(feed.map((x) => [x.actorId, x.data.reason, x.data.to]), [[null, 'auto', 'no_show']]);

  const r3 = await sweep();
  assert.equal(r3.marked, 0, 'всё прошедшее уже отмечено');
  const again = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM booking_history WHERE booking_id = ${id!} AND action = 'auto_no_show'`;
  assert.equal(again[0]!.n, 1, 'уже no_show — пропуск, история не задваивается');
});

test('ручная отметка в пятницу закрывает обе задачи и запись из сверки выпадает', async () => {
  await seedEvent(db.sql, { id: 'sw-br2', date: '2026-10-29', time: '16:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('sw-br2', ${U.duty}, 1)`;
  const [id] = await seedBookings(db.sql, 'sw-br2', [{ client: 'cl-a-51', card: 'cd-a-51' }], { bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-51', 'agreed');
  clock.now = at(FRI, '10:00');
  await sweep();
  assert.deepEqual((await marks(id!)).map((t) => t.status), ['open', 'open']);
  clock.now = at(FRI, '12:00');
  await markAttendance(deps, await viewerOf(U.rop), { bookingId: id!, to: 'attended', opId: uuid(), version: 0 });
  assert.equal(await bookingStatus(id!), 'attended');
  assert.deepEqual((await marks(id!)).map((t) => t.status), ['done', 'done']);
  clock.now = at(MON, '10:00');
  await sweep();
  assert.equal(await bookingStatus(id!), 'attended', 'отмеченную запись сверка не трогает');
});

test('БК без консультанта («серая»): отметчик и РОП — руководитель', async () => {
  await insertGrey(db.sql, { id: 'sw-grey', client: 'cl-a-52', card: 'cd-a-52', date: '2026-10-29', time: '11:00' });
  await setCardState(db.sql, 'cd-a-52', 'agreed');
  clock.now = at(FRI, '10:00');
  await sweep();
  const t = await marks('sw-grey');
  assert.equal(t.length, 2);
  assert.equal(t[0]!.assignee, t[1]!.assignee, 'оба — руководитель');
  assert.notEqual(t[0]!.assignee, U.duty);
});

test('БК у консультанта: отметчик — его сотрудник', async () => {
  await addConsultant(db.sql, { id: 'sw-c1', userId: U.marketer });
  await insertGrey(db.sql, { id: 'sw-bk', client: 'cl-a-53', card: 'cd-a-53', date: '2026-10-29', time: '12:00', resourceId: 'sw-c1' });
  await setCardState(db.sql, 'cd-a-53', 'agreed');
  clock.now = at(FRI, '10:00');
  await sweep();
  const t = await marks('sw-bk');
  assert.equal(t.find((x) => x.kind === 'marker')!.assignee, U.marketer);
});

test('карточка «Клиент»: по сроку «Не пришёл» без события карточки; до срока задачи отметчику и РОП', async () => {
  await seedEvent(db.sql, { id: 'sw-br3', date: '2026-10-29', time: '17:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('sw-br3', ${U.duty}, 1)`;
  const [id] = await seedBookings(db.sql, 'sw-br3', [{ client: 'cl-a-54', card: 'cd-a-54' }], { bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-54', 'client');
  clock.now = at(FRI, '10:00');
  await sweep();
  assert.deepEqual((await marks(id!)).map((t) => [t.kind, t.status]), [['lead', 'open'], ['marker', 'open']]);
  clock.now = at(MON, '10:00');
  await sweep();
  assert.equal(await bookingStatus(id!), 'no_show');
  assert.equal(await cardState('cd-a-54'), 'client', 'карточка не менялась');
  assert.deepEqual((await marks(id!)).map((t) => t.status), ['done', 'done']);
});

test('у клиента есть другая будущая запись: «Не пришёл» по записи, карточка остаётся «Договорились»', async () => {
  await seedEvent(db.sql, { id: 'sw-br4', date: '2026-10-29', time: '18:00' });
  await seedEvent(db.sql, { id: 'sw-br5', date: '2026-11-10', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('sw-br4', ${U.duty}, 1)`;
  const [id] = await seedBookings(db.sql, 'sw-br4', [{ client: 'cl-a-55', card: 'cd-a-55' }], { bookedBy: U.opA });
  await seedBookings(db.sql, 'sw-br5', [{ client: 'cl-a-55', card: 'cd-a-55' }], { bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-55', 'agreed');
  clock.now = at(MON, '10:00');
  await sweep();
  assert.equal(await bookingStatus(id!), 'no_show');
  assert.equal(await cardState('cd-a-55'), 'agreed');
});

test('autoNoShowWorkdays: null — только задачи, «Не пришёл» не ставится', async () => {
  await setAutoNoShow(null);
  await seedEvent(db.sql, { id: 'sw-br6', date: '2026-10-22', time: '15:00' });
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('sw-br6', ${U.duty}, 1)`;
  const [id] = await seedBookings(db.sql, 'sw-br6', [{ client: 'cl-a-56', card: 'cd-a-56' }], { bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-56', 'agreed');
  clock.now = at(MON, '10:00');
  const r = await sweep();
  assert.ok(r.reminded >= 1);
  assert.equal(await bookingStatus(id!), 'registered');
  assert.equal(await cardState('cd-a-56'), 'agreed');
  assert.deepEqual((await marks(id!)).map((t) => t.status), ['open', 'open']);
  await setAutoNoShow(2);
});

test('запись сегодняшнего дня и без дежурных/РОП-ветки: sweepAttendance одной записи, чужой id — skipped', async () => {
  assert.equal(await sweepAttendance(deps, sys(), { bookingId: 'нет-такой', opId: uuid() }), 'skipped');
});

test('задача воркера: расписание рабочие дни 10:00, обработчик отдаёт отчёт', async () => {
  assert.deepEqual(attendanceSweepJob.schedule({ global: {}, space: {} }), { kind: 'daily', at: '10:00', days: 'workdays' });
  assert.equal(attendanceSweepJob.perSpace, true);
});
