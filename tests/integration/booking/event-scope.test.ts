// Мероприятие целиком (экран дежурства, «остальные не пришли», гость без записи) — D-317: охват роли own на
// пишущее разрешение мероприятие не открывает, только team/space/all или отношение duty_today. Чтение расписания —
// по-прежнему любым охватом (D-136, D-161). Роль менеджера пресета base работает так же, как оператор клиента.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RolesSchema, type RoleConfig } from '../../../packages/core/src/access/roles';
import { scopeSql, scoped } from '../../../src/server/access/scope';
import { testViewer } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import type { Permission } from '../../../packages/core/src/access';
import { getDutyEvent, listDutyEvents } from '../../../src/server/domain/booking/duty';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, SEED_NOW, SEED_TZ, SPACE, U } from '../../isolation/harness/seed';
import { closeWorld, fakeCardPort, makeDeps, openBookingWorld } from './helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const EVENTS = [FX.eventToday.event, FX.eventTomorrow.event].sort();

let db: TestDb;
let deps: BookingDeps;
before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
});
after(() => closeWorld(db));

function baseRole(key: string): RoleConfig {
  const doc = JSON.parse(readFileSync(join(ROOT, 'presets', 'base', 'preset.json'), 'utf8')) as { global: { roles: unknown } };
  const role = RolesSchema.parse(doc.global.roles).find((r) => r.key === key);
  if (!role) throw new Error(`в base нет роли ${key}`);
  return role;
}

const viewer = (userId: string, role: RoleConfig): Viewer => testViewer({ userId, role, spaceId: SPACE, now: SEED_NOW, timeZone: SEED_TZ });

async function events(v: Viewer, perm: Permission): Promise<string[]> {
  const rows = await scoped(db.sql)<{ id: string }>`SELECT e.id FROM events e WHERE ${scopeSql(v, 'event', perm)} ORDER BY 1`;
  return rows.map((r) => r.id);
}

test('охват own на явку и гостя без записи не открывает мероприятие; чтение расписания — открывает', async () => {
  const role = {
    key: 'probe-own',
    label: { ru: 'Проба' },
    readOnly: false,
    grants: [
      { perm: 'booking.read', scope: 'own' },
      { perm: 'booking.attend', scope: 'own' },
      { perm: 'booking.walk_in', scope: 'own' },
    ],
    relations: [],
    fieldAccessDefault: 'edit',
    menu: [],
  } as RoleConfig;
  const v = viewer(U.opA, role);
  assert.deepEqual(await events(v, 'booking.read'), EVENTS, 'расписание');
  assert.deepEqual(await events(v, 'booking.attend'), [], 'явка');
  assert.deepEqual(await events(v, 'booking.walk_in'), [], 'гость без записи');
  assert.deepEqual(await listDutyEvents(deps, v), [], 'экран дежурства');
  await assert.rejects(getDutyEvent(deps, v, FX.eventToday.event), (e: unknown) => e instanceof BookingDomainError && e.code === 'event_not_found');
});

test('base: руководитель (space) — все мероприятия; менеджер — только своё дежурство сегодня', async () => {
  const lead = viewer(U.rop, baseRole('lead'));
  assert.deepEqual(await events(lead, 'booking.walk_in'), EVENTS);
  assert.deepEqual((await listDutyEvents(deps, lead)).map((e) => e.id), [FX.eventToday.event]);

  // не дежурный менеджер: мероприятие для него не существует
  const mgr = viewer(U.opA, baseRole('manager'));
  assert.deepEqual(await events(mgr, 'booking.attend'), []);
  assert.deepEqual(await events(mgr, 'booking.walk_in'), []);
  assert.deepEqual(await listDutyEvents(deps, mgr), []);
  await assert.rejects(getDutyEvent(deps, mgr, FX.eventToday.event), (e: unknown) => e instanceof BookingDomainError && e.code === 'event_not_found');

  // менеджер-дежурный: своё мероприятие сегодня, завтрашнее — нет
  const duty = viewer(U.duty, baseRole('manager'));
  assert.deepEqual(await events(duty, 'booking.walk_in'), [FX.eventToday.event]);
  assert.deepEqual(await events(duty, 'booking.attend'), [FX.eventToday.event]);
  assert.deepEqual((await listDutyEvents(deps, duty)).map((e) => e.id), [FX.eventToday.event]);
  assert.equal((await getDutyEvent(deps, duty, FX.eventToday.event)).id, FX.eventToday.event);
});
