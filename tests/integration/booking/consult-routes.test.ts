// Маршруты консультаций (B5b/B5c) через обёртку route(): рабочие ответы за флагом BK_WIZARD, 404 при выключенном флаге,
// права РОП/оператора/консультанта, тело slot_taken с альтернативами. Статические сегменты /api/bookings/{mine,consult-day,
// consultants} лежат рядом с [id] — Next отдаёт им приоритет.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { overrideBookingDepsForTests } from '../../../src/server/domain/booking/deps';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, U } from '../../isolation/harness/seed';
import * as bookingsRoot from '../../../src/app/api/bookings/route';
import * as assignRoute from '../../../src/app/api/bookings/[id]/assign/route';
import * as candidatesRoute from '../../../src/app/api/bookings/[id]/candidates/route';
import * as resultRoute from '../../../src/app/api/bookings/[id]/result/route';
import * as mineRoute from '../../../src/app/api/bookings/mine/route';
import * as dayRoute from '../../../src/app/api/bookings/consult-day/route';
import * as stripRoute from '../../../src/app/api/bookings/wizard/[cardId]/consult/route';
import * as scheduleRoute from '../../../src/app/api/bookings/consultants/[id]/schedule/route';
import * as exceptionRoute from '../../../src/app/api/bookings/consultants/[id]/exceptions/[day]/route';
import { SEED_NOW, actAs, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, insertGrey, makeDeps, openConsultWorld, uuid, weekdays } from './helpers';

const ORIGIN = 'http://crm.test';
type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
interface Reply {
  status: number;
  json: Record<string, unknown> & unknown[];
}

let db: TestDb;

async function call(handler: Handler, method: string, path: string, o: { as: string | null; body?: unknown; params?: Record<string, string> }): Promise<Reply> {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  let json: Reply['json'];
  try {
    json = JSON.parse(text) as Reply['json'];
  } catch {
    json = {} as Reply['json'];
  }
  return { status: res.status, json };
}

before(async () => {
  db = await openConsultWorld();
  overrideBookingDepsForTests(makeDeps({ now: SEED_NOW }, fakeCardPort()));
  await addConsultant(db.sql, { id: 'r1', userId: U.marketer, directions: ['marketing'] });
  await addConsultant(db.sql, { id: 'r2', userId: U.mktHead, directions: ['consulting'] });
  await addSchedule(db.sql, 'r1', weekdays('09:00', '13:30'));
  await addSchedule(db.sql, 'r2', weekdays('09:00', '13:30'));
});
after(async () => {
  overrideBookingDepsForTests(null);
  await closeConsultWorld(db);
});

test('статические сегменты лежат рядом с [id]: mine, consult-day, consultants', () => {
  for (const seg of ['mine', 'consult-day', 'consultants']) assert.ok(existsSync(join(process.cwd(), 'src/app/api/bookings', seg, 'route.ts')), seg);
  assert.ok(existsSync(join(process.cwd(), 'src/app/api/bookings/[id]/route.ts')));
});

test('график и исключения: РОП 200, оператор 403, плохое тело 400/schedule_overlap', async () => {
  const params = { id: 'r1' };
  const put = await call(scheduleRoute.PUT, 'PUT', '/x', { as: U.rop, params, body: { windows: [{ weekday: 2, start: '09:00', end: '12:00' }] } });
  assert.equal(put.status, 200);
  assert.equal((put.json.windows as unknown[]).length, 1);
  assert.equal((await call(scheduleRoute.GET, 'GET', '/x', { as: U.rop, params })).status, 200);
  assert.equal((await call(scheduleRoute.PUT, 'PUT', '/x', { as: U.opA, params, body: { windows: [] } })).status, 403);
  assert.equal((await call(scheduleRoute.PUT, 'PUT', '/x', { as: U.rop, params, body: { windows: [{ weekday: 9, start: '09:00', end: '12:00' }] } })).status, 400);
  assert.equal((await call(scheduleRoute.PUT, 'PUT', '/x', { as: U.rop, params, body: { windows: [{ weekday: 2, start: '09:00', end: '12:00' }, { weekday: 2, start: '11:00', end: '13:00' }] } })).status, 400);
  const exc = { id: 'r1', day: '2026-11-04' };
  const off = await call(exceptionRoute.PUT, 'PUT', '/x', { as: U.rop, params: exc, body: { kind: 'off', windows: [] } });
  assert.equal(off.status, 200);
  assert.equal((off.json.exceptions as unknown[]).length, 1);
  const del = await call(exceptionRoute.DELETE, 'DELETE', '/x', { as: U.rop, params: exc });
  assert.deepEqual([del.status, (del.json.exceptions as unknown[]).length], [200, 0]);
  assert.equal((await call(scheduleRoute.GET, 'GET', '/x', { as: U.rop, params: { id: 'нет' } })).status, 404);
});

test('день, полоса, кандидаты, назначение: ответы РОП и оператора', async () => {
  await insertGrey(db.sql, { id: 'rt-grey', client: 'cl-a-90', card: 'cd-a-90', date: '2026-11-03', time: '09:00' });
  const day = await call(dayRoute.GET, 'GET', '/api/bookings/consult-day?date=2026-11-03', { as: U.rop });
  assert.equal(day.status, 200);
  assert.deepEqual((day.json.unassigned as Array<{ bookingId: string }>).map((b) => b.bookingId), ['rt-grey']);
  assert.equal((await call(dayRoute.GET, 'GET', '/api/bookings/consult-day?date=2026-11-03', { as: U.opA })).status, 403);
  assert.equal((await call(dayRoute.GET, 'GET', '/api/bookings/consult-day?date=плохо', { as: U.rop })).status, 400);

  const strip = await call(stripRoute.GET, 'GET', '/x?type=bk&direction=marketing', { as: U.opA, params: { cardId: 'cd-a-91' } });
  assert.equal(strip.status, 200);
  assert.ok((strip.json.days as unknown[]).length > 0);
  assert.equal((await call(stripRoute.GET, 'GET', '/x?type=bk&direction=marketing', { as: U.opA, params: { cardId: 'cd-b-1' } })).status, 404);
  assert.equal((await call(stripRoute.GET, 'GET', '/x?type=br&direction=marketing', { as: U.opA, params: { cardId: 'cd-a-91' } })).status, 409);

  const cands = await call(candidatesRoute.GET, 'GET', '/x', { as: U.rop, params: { id: 'rt-grey' } });
  assert.equal(cands.status, 200);
  assert.deepEqual((cands.json as unknown as Array<{ resourceId: string }>).map((c) => c.resourceId), ['r1', 'r2']);
  assert.equal((await call(candidatesRoute.GET, 'GET', '/x', { as: U.opA, params: { id: 'rt-grey' } })).status, 404);

  const ok = await call(assignRoute.POST, 'POST', '/x', { as: U.rop, params: { id: 'rt-grey' }, body: { opId: uuid(), version: 0, resourceId: 'r1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.resourceId, 'r1');
  const taken = await call(assignRoute.POST, 'POST', '/x', { as: U.rop, params: { id: 'rt-grey' }, body: { opId: uuid(), version: 1, resourceId: 'нет' } });
  assert.deepEqual([taken.status, taken.json.detail], [404, undefined]);
});

test('запись к консультанту через POST /api/bookings: 201; занятый слот — 409 slot_taken с альтернативами', async () => {
  const body = (client: string, time: string, resourceId: string | null) => ({ kind: 'individual', requestId: uuid(), clientId: client, eventTypeKey: 'bk', date: '2026-11-03', time, directionKey: 'marketing', resourceId, contactId: null });
  const first = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opA, body: body('cl-a-92', '10:30', 'r1') });
  assert.equal(first.status, 201);
  const taken = await call(bookingsRoot.POST, 'POST', '/api/bookings', { as: U.opB, body: body('cl-b-92', '10:30', 'r1') });
  assert.deepEqual([taken.status, taken.json.error, taken.json.detail], [409, 'conflict', 'slot_taken']);
  assert.deepEqual((taken.json.alternatives as Array<{ resourceId: string }>).map((a) => a.resourceId), ['r2']);
});

test('мои консультации и итог: консультант 200, чужая встреча 404, до явки — 409 not_attended', async () => {
  const mine = await call(mineRoute.GET, 'GET', '/api/bookings/mine?from=2026-10-28&to=2026-11-11', { as: U.consultant });
  assert.equal(mine.status, 200);
  const ids = (mine.json as unknown as Array<{ bookingId: string }>).map((b) => b.bookingId);
  assert.ok(ids.includes(FX.bkInWindow.booking) && !ids.includes(FX.bkOther.booking));
  assert.equal((await call(mineRoute.GET, 'GET', '/api/bookings/mine?from=2026-10-28&to=2027-06-01', { as: U.consultant })).status, 400);

  const body = { opId: uuid(), note: 'Итог', nextStep: null, toStageKey: null, dealVersion: null };
  const early = await call(resultRoute.POST, 'POST', '/x', { as: U.consultant, params: { id: FX.bkInWindow.booking }, body });
  assert.deepEqual([early.status, early.json.detail], [409, 'not_attended']);
  assert.equal((await call(resultRoute.POST, 'POST', '/x', { as: U.consultant, params: { id: FX.bkOther.booking }, body })).status, 404);
  assert.equal((await call(resultRoute.POST, 'POST', '/x', { as: U.opA, params: { id: FX.bkInWindow.booking }, body })).status, 404);
  await db.sql`UPDATE bookings SET status = 'attended' WHERE id = ${FX.bkInWindow.booking}`;
  const done = await call(resultRoute.POST, 'POST', '/x', { as: U.consultant, params: { id: FX.bkInWindow.booking }, body });
  assert.deepEqual([done.status, done.json.replayed], [200, false]);
});

test('флаг BK_WIZARD выключен: маршруты B5b/B5c отвечают 404, назначение и список консультантов работают (D-203)', async () => {
  process.env['FEATURE_BK_WIZARD'] = '0';
  try {
    const gone = [
      await call(scheduleRoute.GET, 'GET', '/x', { as: U.rop, params: { id: 'r1' } }),
      await call(scheduleRoute.PUT, 'PUT', '/x', { as: U.rop, params: { id: 'r1' }, body: { windows: [] } }),
      await call(exceptionRoute.DELETE, 'DELETE', '/x', { as: U.rop, params: { id: 'r1', day: '2026-11-04' } }),
      await call(dayRoute.GET, 'GET', '/x?date=2026-11-03', { as: U.rop }),
      await call(stripRoute.GET, 'GET', '/x?type=bk&direction=marketing', { as: U.opA, params: { cardId: 'cd-a-93' } }),
      await call(mineRoute.GET, 'GET', '/x?from=2026-10-28&to=2026-11-11', { as: U.consultant }),
      await call(resultRoute.POST, 'POST', '/x', { as: U.consultant, params: { id: FX.bkInWindow.booking }, body: { opId: uuid(), note: 'Итог', nextStep: null, toStageKey: null, dealVersion: null } }),
    ];
    assert.deepEqual(gone.map((r) => r.status), [404, 404, 404, 404, 404, 404, 404]);
    await insertGrey(db.sql, { id: 'rt-off', client: 'cl-a-94', card: 'cd-a-94', date: '2026-11-03', time: '15:00' });
    const assigned = await call(assignRoute.POST, 'POST', '/x', { as: U.rop, params: { id: 'rt-off' }, body: { opId: uuid(), version: 0, resourceId: 'r2' } });
    assert.equal(assigned.status, 200);
  } finally {
    process.env['FEATURE_BK_WIZARD'] = '1';
  }
});
