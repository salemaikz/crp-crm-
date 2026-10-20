// Автоназначение «серых» (B5b, §4.8, D-247): режимы assign и suggest, задача РОП для не подобранных, повторный прогон,
// заявки прошедшего времени не трогаются, флаг выключен — задача пропущена.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { systemActor } from '../../../src/server/access/systemActor';
import { greyAssignJob, greyAssignSchedule } from '../../../src/server/domain/booking/jobs';
import { runGreyAssign } from '../../../src/server/domain/booking/greyJob';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { JobContext } from '../../../src/server/platform/jobs/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, SPACE, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, insertGrey, makeDeps, openConsultWorld, setGreyConfig, weekdays } from './helpers';

const TODAY = '2026-10-28';
let db: TestDb;
let deps: BookingDeps;
const clock = { now: SEED_NOW };
const sys = () => systemActor('grey-assign@sales', clock.now);

const resourceOf = async (id: string) => (await db.sql<{ resourceId: string | null }>`SELECT resource_id FROM bookings WHERE id = ${id}`)[0]!.resourceId;
const taskStatus = async (id: string) => (await db.sql<{ status: string }>`SELECT status FROM tasks WHERE source_key = ${`grey_unassigned:${id}`}`).map((t) => t.status);

before(async () => {
  db = await openConsultWorld({ mode: 'assign' });
  deps = makeDeps(clock, fakeCardPort());
  await addConsultant(db.sql, { id: 'c1', userId: U.marketer, directions: ['marketing'], sort: 1 });
  await addConsultant(db.sql, { id: 'c2', userId: U.mktHead, directions: ['consulting'], sort: 2 });
  await addSchedule(db.sql, 'c1', weekdays('09:00', '18:00'));
});
after(() => closeConsultWorld(db));

test('расписание задачи: сетка по рабочим дням из booking.grey.schedule; нет документа — задачи нет', () => {
  const spec = greyAssignSchedule({ global: {}, space: { booking: { grey: { mode: 'assign', schedule: { first: '09:00', last: '18:00', stepMin: 30 } } } } });
  assert.deepEqual(spec, { kind: 'grid', from: '09:00', to: '18:00', everyMin: 30, days: 'workdays', graceMin: 30 });
  assert.equal(greyAssignSchedule({ global: {}, space: null }), null);
});

test('assign: три «серые» на одно время, два консультанта — две назначены по рангу, третья — задача РОП; следом новый консультант её берёт', async () => {
  await insertGrey(db.sql, { id: 'g1', client: 'cl-a-70', card: 'cd-a-70', date: TODAY, time: '14:15', createdAt: SEED_NOW - 3000 });
  await insertGrey(db.sql, { id: 'g2', client: 'cl-a-71', card: 'cd-a-71', date: TODAY, time: '14:15', createdAt: SEED_NOW - 2000 });
  await insertGrey(db.sql, { id: 'g3', client: 'cl-a-72', card: 'cd-a-72', date: TODAY, time: '14:15', createdAt: SEED_NOW - 1000 });
  // прошедшего времени не касаемся: консультация состоялась или сорвалась
  await insertGrey(db.sql, { id: 'gp', client: 'cl-a-73', card: 'cd-a-73', date: TODAY, time: '09:45' });
  const rep = await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.deepEqual([rep.date, rep.mode, rep.assigned, rep.suggested, rep.unassignable], [TODAY, 'assign', 2, 0, 1]);
  assert.equal(await resourceOf('g1'), 'c1', 'направление совпало — c1 первым');
  assert.equal(await resourceOf('g2'), 'c2');
  assert.equal(await resourceOf('g3'), null);
  assert.equal(await resourceOf('gp'), null);
  assert.deepEqual(await taskStatus('g3'), ['open']);
  assert.deepEqual(await taskStatus('gp'), []);
  const h = await db.sql<{ actorId: string | null; meta: Record<string, unknown> }>`SELECT actor_id, meta FROM booking_history WHERE booking_id = 'g1' AND action = 'assigned'`;
  assert.deepEqual(h.map((x) => [x.actorId, x.meta.auto]), [[null, true]]);
  const n = await db.sql<{ userId: string; kind: string }>`SELECT user_id, kind FROM notifications WHERE entity_id = 'g1' ORDER BY kind`;
  assert.deepEqual(n.map((x) => [x.userId, x.kind]), [[U.marketer, 'booking_consult_new'], [U.opA, 'consultant_assigned']]);

  // повторный прогон ничего не меняет и не дублирует задачу
  const again = await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.deepEqual([again.assigned, again.unassignable], [0, 1]);
  assert.deepEqual(await taskStatus('g3'), ['open']);

  // появился свободный консультант (общие часы) — следующий прогон назначает и закрывает задачу
  await addConsultant(db.sql, { id: 'c3', userId: U.opB, sort: 3 });
  const third = await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.deepEqual([third.assigned, third.unassignable], [1, 0]);
  assert.equal(await resourceOf('g3'), 'c3');
  assert.deepEqual(await taskStatus('g3'), ['done']);
});

test('заявку, уже назначенную человеком, прогон не переписывает', async () => {
  await insertGrey(db.sql, { id: 'gh', client: 'cl-a-74', card: 'cd-a-74', date: TODAY, time: '16:30', direction: 'consulting' });
  await db.sql`UPDATE resources SET active = FALSE WHERE id = 'c3'`;
  await db.sql`UPDATE bookings SET resource_id = 'c2' WHERE id = 'gh'`;
  const rep = await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.equal(rep.assigned, 0);
  assert.equal(await resourceOf('gh'), 'c2');
});

test('suggest: назначения нет, колокол РОП один раз на заявку', async () => {
  await setGreyConfig({ mode: 'suggest' });
  await db.sql`UPDATE resources SET active = FALSE WHERE id = 'c3'`;
  await insertGrey(db.sql, { id: 's1', client: 'cl-a-75', card: 'cd-a-75', date: TODAY, time: '17:15' });
  await insertGrey(db.sql, { id: 's2', client: 'cl-a-76', card: 'cd-a-76', date: TODAY, time: '17:15' });
  const rep = await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.deepEqual([rep.mode, rep.assigned, rep.suggested], ['suggest', 0, 2]);
  assert.equal(await resourceOf('s1'), null);
  assert.equal(await resourceOf('s2'), null);
  const count = async () => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE kind = 'grey_suggest'`)[0]!.n;
  assert.equal(await count(), 2);
  await runGreyAssign(deps, sys(), { spaceId: SPACE, now: clock.now });
  assert.equal(await count(), 2, 'повторный прогон колокол не дублирует');
  await setGreyConfig({ mode: 'assign' });
});

test('задача воркера: флаг выключен — skipped flag_off; включён — ok со счётчиками', async () => {
  const ctx = { actor: sys(), space: { id: SPACE, key: 'sales' }, now: clock.now, log: { info() {}, warn() {} } } as unknown as JobContext;
  process.env['FEATURE_BK_WIZARD'] = '0';
  try {
    assert.deepEqual(await greyAssignJob.handler(ctx), { status: 'skipped', stats: {}, note: 'flag_off' });
  } finally {
    process.env['FEATURE_BK_WIZARD'] = '1';
  }
  const res = await greyAssignJob.handler(ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(Object.keys(res.stats).sort(), ['assigned', 'suggested', 'unassignable']);
});
