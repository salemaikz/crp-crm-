// Инвариант «Договорились» (B4b, §3.3, D-049, D-244; PROCESS 3.5 № 29): карточка без активной будущей записи и без
// открытой задачи со сроком получает задачу «Записать на следующий шаг»; чужая задача со сроком считается шагом.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { booking } from '../../../packages/core/src';
import { systemActor } from '../../../src/server/access/systemActor';
import { runAttendanceSweep, countAgreedWithoutStep } from '../../../src/server/domain/booking/sweep';
import { cardBookingPort } from '../../../src/server/domain/cards/bookingPort';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { SEED_TZ, closeDutyWorld, makeDeps, openDutyWorld, seedBookings, seedEvent, setCardState } from './helpers';

let db: TestDb;
let deps: BookingDeps;
const NOW = booking.localToEpoch(SEED_TZ, '2026-10-28', '02:00');
const clock = { now: NOW };
const sys = () => systemActor('attendance-sweep@sales', clock.now);
const sweep = () => runAttendanceSweep(deps, sys(), { spaceId: SPACE, now: clock.now });
const steps = (client: string) =>
  db.sql<{ assignee: string | null; status: string; dueAt: number | null; sourceKey: string }>`
    SELECT assignee_user_id AS assignee, status, due_at, source_key FROM tasks WHERE client_id = ${client} AND source = 'next_step'`;

before(async () => {
  db = await openDutyWorld();
  deps = makeDeps(clock, cardBookingPort);
  await db.sql`UPDATE cards SET state = 'client' WHERE state = 'agreed'`;
  // Нужные карточки — «Договорились»
  for (const n of [60, 61, 62, 63]) await setCardState(db.sql, `cd-a-${n}`, 'agreed');
});
after(() => closeDutyWorld(db));

test('countAgreedWithoutStep: до и после прогона', async () => {
  const before = await countAgreedWithoutStep(sys());
  assert.equal(before, 4);
});

test('«Договорились» без записи и задач — задача next_step владельцу на следующий шаг по настройкам', async () => {
  // у карточек 61–63 есть шаг
  await seedEvent(db.sql, { id: 'ag-ev', date: '2026-11-05', time: '15:00' });
  await seedBookings(db.sql, 'ag-ev', [{ client: 'cl-a-61', card: 'cd-a-61' }], { bookedBy: U.opA });
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, created_at)
    VALUES ('ag-t-cons', ${SPACE}, 'cl-a-62', 'call', 'manual', '', ${NOW + 86_400_000}, ${U.marketer}, 'open', ${NOW})`;
  // открытая задача БЕЗ срока шагом не считается
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, created_at)
    VALUES ('ag-t-nodue', ${SPACE}, 'cl-a-63', 'call', 'callback', '', NULL, ${U.opA}, 'open', ${NOW})`;

  const r = await sweep();
  assert.ok(r.nextStepTasks >= 2);
  const own = await steps('cl-a-60');
  assert.equal(own.length, 1);
  assert.equal(own[0]!.assignee, U.opA);
  assert.equal(own[0]!.status, 'open');
  assert.equal(own[0]!.dueAt, booking.localToEpoch(SEED_TZ, '2026-10-29', '10:00'), 'booking.nextStep.taskAt = nextWorkday@10:00');
  assert.match(own[0]!.sourceKey, /^next_step:sweep:cd-a-60:2026-10-28$/);
  assert.equal((await steps('cl-a-63')).length, 1, 'задача без срока — не шаг');
  assert.equal((await steps('cl-a-61')).length, 0, 'будущая запись — шаг');
  assert.equal((await steps('cl-a-62')).length, 0, 'задача консультанта со сроком — шаг');
});

test('повтор в тот же день — одна задача; после прогона инвариант выполнен', async () => {
  await sweep();
  assert.equal((await steps('cl-a-60')).length, 1);
  assert.equal(await countAgreedWithoutStep(sys()), 0);
});

test('будущая запись отменена — карточка снова попадает в сверку', async () => {
  await db.sql`UPDATE bookings SET status = 'cancelled' WHERE client_id = 'cl-a-61'`;
  assert.equal(await countAgreedWithoutStep(sys()), 1);
  await sweep();
  assert.equal((await steps('cl-a-61')).length, 1);
});
