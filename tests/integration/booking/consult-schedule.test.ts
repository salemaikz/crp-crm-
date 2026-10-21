// График, исключения и экран дня РОП (B5b, §4.4–4.5): проверки окон, исключение «off» гасит день, «custom» открывает,
// аудит, права; день — слоты консультантов, «серые» и конфликты (выключенный консультант, выпавшая из графика запись).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, ForbiddenError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { clearException, getSchedule, listConsultants, setException, setSchedule } from '../../../src/server/domain/booking/consultants';
import { getConsultDay, getConsultStrip } from '../../../src/server/domain/booking/consultDay';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, addConsultant, addSchedule, closeConsultWorld, fakeCardPort, insertGrey, makeDeps, openConsultWorld, setGreyConfig, viewerOf, weekdays } from './helpers';

const DAY = '2026-11-03'; // вторник
let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let opA: Viewer;
const clock = { now: SEED_NOW };

const w = (weekday: number, start: string, end: string) => ({ weekday, start, end });
const overlap = (e: unknown) => e instanceof BookingDomainError && e.code === 'schedule_overlap';
const times = async (date: string, id = 'sch') => {
  const strip = await getConsultStrip(deps, rop, { cardId: 'cd-a-80', eventTypeKey: 'bk', directionKey: 'marketing' });
  return strip.days.find((d) => d.date === date)?.slots.filter((s) => s.suggested?.resourceId === id || s.others.some((o) => o.resourceId === id)).map((s) => s.time) ?? [];
};

before(async () => {
  db = await openConsultWorld();
  deps = makeDeps(clock, fakeCardPort());
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
  await addConsultant(db.sql, { id: 'sch', userId: U.marketer, directions: ['marketing'] });
});
after(() => closeConsultWorld(db));

test('график: пересечение окон — schedule_overlap, касание допустимо; слишком много окон и мусор — 400; права', async () => {
  await assert.rejects(setSchedule(deps, rop, { resourceId: 'sch', windows: [w(2, '09:00', '12:00'), w(2, '11:30', '13:00')] }), overlap);
  for (const bad of [[w(2, '12:00', '09:00')], [w(2, '09:00', '09:00')], [w(0, '09:00', '10:00')], [w(8, '09:00', '10:00')], [w(2, '9:00', '10:00')], Array.from({ length: 22 }, () => w(1, '09:00', '10:00'))]) {
    await assert.rejects(setSchedule(deps, rop, { resourceId: 'sch', windows: bad }), (e: unknown) => e instanceof BadRequestError || overlap(e));
  }
  const out = await setSchedule(deps, rop, { resourceId: 'sch', windows: [w(2, '09:00', '12:00'), w(2, '12:00', '13:30'), w(3, '10:00', '12:00')] });
  assert.deepEqual(out.windows.map((x) => [x.weekday, x.start, x.end]), [[2, '09:00', '12:00'], [2, '12:00', '13:30'], [3, '10:00', '12:00']]);
  assert.equal((await listConsultants(deps, rop, { includeInactive: false })).find((c) => c.id === 'sch')!.usesSchedule, true);
  await assert.rejects(setSchedule(deps, opA, { resourceId: 'sch', windows: [] }), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(setSchedule(deps, rop, { resourceId: 'нет', windows: [] }), (e: unknown) => e instanceof BookingDomainError && e.code === 'consultant_not_found');
  const audit = await db.sql<{ action: string; entity: string; entityId: string }>`SELECT action, entity, entity_id FROM audit_log WHERE action = 'consultant.schedule'`;
  assert.ok(audit.length >= 1 && audit.every((a) => a.entity === 'resource' && a.entityId === 'sch'));
  // замена целиком: старые окна исчезают
  const replaced = await setSchedule(deps, rop, { resourceId: 'sch', windows: [w(2, '10:00', '11:30')] });
  assert.equal(replaced.windows.length, 1);
});

test('исключение «off» гасит день, «custom» открывает особые часы, удаление возвращает недельный график', async () => {
  await setSchedule(deps, rop, { resourceId: 'sch', windows: [w(2, '10:00', '11:30')] });
  assert.deepEqual(await times(DAY), ['10:00', '10:45']);
  await setException(deps, rop, { resourceId: 'sch', day: DAY, kind: 'off', windows: [] });
  assert.deepEqual(await times(DAY), []);
  const custom = await setException(deps, rop, { resourceId: 'sch', day: DAY, kind: 'custom', windows: [{ start: '14:00', end: '15:30' }] });
  assert.deepEqual(custom.exceptions.map((e) => [e.day, e.kind, e.windows]), [[DAY, 'custom', [{ start: '14:00', end: '15:30' }]]]);
  assert.deepEqual(await times(DAY), ['14:00', '14:45']);
  const cleared = await clearException(deps, rop, { resourceId: 'sch', day: DAY });
  assert.deepEqual(cleared.exceptions, []);
  assert.deepEqual(await times(DAY), ['10:00', '10:45']);
  // проверки исключения
  await assert.rejects(setException(deps, rop, { resourceId: 'sch', day: DAY, kind: 'off', windows: [{ start: '10:00', end: '11:00' }] }), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(setException(deps, rop, { resourceId: 'sch', day: DAY, kind: 'custom', windows: [] }), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(setException(deps, rop, { resourceId: 'sch', day: DAY, kind: 'custom', windows: [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '13:00' }] }), overlap);
  await assert.rejects(setException(deps, rop, { resourceId: 'sch', day: '2026-10-01', kind: 'off', windows: [] }), (e: unknown) => e instanceof BadRequestError);
  // исключение «custom» хранится в формате ядра {start, end}
  await setException(deps, rop, { resourceId: 'sch', day: '2026-11-04', kind: 'custom', windows: [{ start: '09:00', end: '10:00' }] });
  const raw = await db.sql<{ windows: unknown }>`SELECT windows FROM resource_exceptions WHERE resource_id = 'sch' AND day = '2026-11-04'`;
  assert.deepEqual(raw[0]!.windows, [{ start: '09:00', end: '10:00' }]);
  await clearException(deps, rop, { resourceId: 'sch', day: '2026-11-04' });
  assert.deepEqual((await getSchedule(deps, rop, 'sch')).exceptions, []);
});

test('день РОП: слоты и записи консультанта, «серые», конфликты — выключенный консультант и запись вне графика', async () => {
  await addConsultant(db.sql, { id: 'gone', userId: U.opB, directions: ['consulting'] });
  await addSchedule(db.sql, 'gone', weekdays('09:00', '12:00'));
  await insertGrey(db.sql, { id: 'd-main', client: 'cl-a-80', card: 'cd-a-80', date: DAY, time: '10:00', resourceId: 'sch' });
  await insertGrey(db.sql, { id: 'd-grey', client: 'cl-a-81', card: 'cd-a-81', date: DAY, time: '11:15' });
  await insertGrey(db.sql, { id: 'd-orph', client: 'cl-a-82', card: 'cd-a-82', date: DAY, time: '09:45', resourceId: 'gone' });
  await insertGrey(db.sql, { id: 'd-drop', client: 'cl-a-83', card: 'cd-a-83', date: DAY, time: '16:30', resourceId: 'sch' });
  await db.sql`UPDATE resources SET active = FALSE WHERE id = 'gone'`;
  const view = await getConsultDay(deps, rop, { date: DAY });
  assert.equal(view.date, DAY);
  const sch = view.consultants.find((c) => c.resourceId === 'sch')!;
  assert.deepEqual([sch.working, sch.hours], [true, { start: '10:00', end: '11:30' }]);
  assert.deepEqual(sch.bookings.map((b) => b.bookingId), ['d-main']);
  assert.equal(sch.bookings[0]!.clientName !== '', true);
  assert.deepEqual(sch.slots.map((s) => [s.time, s.taken]), [['10:00', 1], ['10:45', 0]]);
  assert.deepEqual(view.unassigned.map((b) => b.bookingId), ['d-grey']);
  assert.deepEqual(view.conflicts.map((b) => b.bookingId), ['d-orph', 'd-drop']);
  assert.ok(!view.consultants.some((c) => c.resourceId === 'gone'), 'выключенного в списке дня нет');
  // права: оператор — 403; плохая дата — 400
  await assert.rejects(getConsultDay(deps, opA, { date: DAY }), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(getConsultDay(deps, rop, { date: '03.11.2026' }), (e: unknown) => e instanceof BadRequestError);
});

test('полоса подбора несёт шаг прогона автоназначения из настроек: подсказка «подберём в ближайшие N минут» без числа в локали', async () => {
  await setSchedule(deps, rop, { resourceId: 'sch', windows: [w(2, '10:00', '11:30')] });
  await setGreyConfig({ mode: 'assign', stepMin: 60 });
  try {
    const strip = await getConsultStrip(deps, rop, { cardId: 'cd-a-80', eventTypeKey: 'bk', directionKey: 'marketing' });
    assert.ok(strip.days.length > 0);
    assert.deepEqual([...new Set(strip.days.map((d) => d.greyStepMin))], [60]);
  } finally {
    await setGreyConfig({ mode: 'assign' });
  }
});
