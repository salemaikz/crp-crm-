// Консультанты (B5a): список, создание с идемпотентностью, правка с токеном, выключение, права РОП.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, ConflictError, ForbiddenError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { createConsultant, listConsultants, updateConsultant } from '../../../src/server/domain/booking/consultants';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let rop: Viewer;
let opA: Viewer;
const clock = { now: SEED_NOW };

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
const input = (userId: string, over: Record<string, unknown> = {}) => ({
  requestId: uuid(),
  userId,
  directions: ['marketing', 'consulting'],
  slotMin: 45,
  capacity: 1,
  autoAssign: true,
  sort: 10,
  ...over,
});

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps(clock, fakeCardPort());
  rop = await viewerOf(U.rop);
  opA = await viewerOf(U.opA);
});
after(() => closeWorld(db));

test('список: сидовые консультанты по порядку и имени; график не используется', async () => {
  const list = await listConsultants(deps, rop, { includeInactive: false });
  assert.deepEqual(list.map((c) => c.userId).sort(), [U.consultant, U.rop].sort());
  assert.ok(list.every((c) => c.active && !c.usesSchedule && c.name !== ''));
});

test('создать: повтор requestId возвращает того же, второй ресурс сотрудника — consultant_exists', async () => {
  const body = input(U.opB);
  const first = await createConsultant(deps, rop, body);
  assert.deepEqual([first.userId, first.slotMin, first.capacity, first.active, first.directions], [U.opB, 45, 1, true, ['marketing', 'consulting']]);
  const again = await createConsultant(deps, rop, body);
  assert.equal(again.id, first.id);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM resources WHERE user_id = ${U.opB}`)[0]?.n, 1);
  await assert.rejects(createConsultant(deps, rop, input(U.opB)), failsWith('consultant_exists'));
  const audit = await db.sql<{ action: string; entity: string; entityId: string }>`SELECT action, entity, entity_id FROM audit_log WHERE action = 'consultant.create'`;
  assert.deepEqual(audit.map((a) => [a.action, a.entity, a.entityId]), [['consultant.create', 'resource', first.id]]);
});

test('создать: чужой ключ запроса — request_reused; не сотрудник пространства, неизвестное направление, слот и места вне границ — 400', async () => {
  const taken = (await listConsultants(deps, rop, { includeInactive: true }))[0]!;
  await assert.rejects(createConsultant(deps, rop, input(U.director, { requestId: taken.id })), failsWith('request_reused'));
  for (const bad of [
    input(U.disabled),
    input(U.marketer, { directions: ['no_such'] }),
    input(U.marketer, { directions: ['marketing', 'marketing'] }),
    input(U.marketer, { slotMin: 4 }),
    input(U.marketer, { slotMin: 481 }),
    input(U.marketer, { capacity: 0 }),
    input(U.marketer, { capacity: 6 }),
    input(U.marketer, { slotMin: 45.5 }),
  ]) {
    await assert.rejects(createConsultant(deps, rop, bad), (e: unknown) => e instanceof BadRequestError);
  }
});

test('править: устаревший seenUpdatedAt — 409; свежий проходит и меняет токен', async () => {
  const c = await createConsultant(deps, rop, input(U.marketer));
  clock.now = SEED_NOW + 1000;
  const next = await updateConsultant(deps, rop, { resourceId: c.id, seenUpdatedAt: c.updatedAt, patch: { slotMin: 60, capacity: 2, autoAssign: false, sort: 3, directions: ['program'] } });
  assert.deepEqual([next.slotMin, next.capacity, next.autoAssign, next.sort, next.directions], [60, 2, false, 3, ['program']]);
  assert.ok(next.updatedAt > c.updatedAt);
  await assert.rejects(updateConsultant(deps, rop, { resourceId: c.id, seenUpdatedAt: c.updatedAt, patch: { sort: 1 } }), (e: unknown) => e instanceof ConflictError);
  await assert.rejects(updateConsultant(deps, rop, { resourceId: c.id, seenUpdatedAt: next.updatedAt, patch: { slotMin: 3 } }), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(updateConsultant(deps, rop, { resourceId: 'rs-missing', seenUpdatedAt: 0, patch: {} }), failsWith('consultant_not_found'));
  const audit = await db.sql<{ meta: { fields: string[] } }>`SELECT meta FROM audit_log WHERE action = 'consultant.update' AND entity_id = ${c.id}`;
  assert.deepEqual(audit.map((a) => a.meta.fields), [['autoAssign', 'capacity', 'directions', 'slotMin', 'sort']]);
});

test('выключить: из списка пропадает, с флагом виден; будущие записи остаются на консультанте', async () => {
  const before = (await listConsultants(deps, rop, { includeInactive: false })).find((c) => c.id === 'rs-cons')!;
  const off = await updateConsultant(deps, rop, { resourceId: 'rs-cons', seenUpdatedAt: before.updatedAt, patch: { active: false } });
  assert.equal(off.active, false);
  assert.equal((await listConsultants(deps, rop, { includeInactive: false })).some((c) => c.id === 'rs-cons'), false);
  assert.equal((await listConsultants(deps, rop, { includeInactive: true })).find((c) => c.id === 'rs-cons')?.active, false);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE resource_id = 'rs-cons' AND status = 'registered'`)[0]?.n, 3);
  const on = await updateConsultant(deps, rop, { resourceId: 'rs-cons', seenUpdatedAt: off.updatedAt, patch: { active: true } });
  assert.equal(on.active, true);
});

test('оператор не управляет консультантами', async () => {
  await assert.rejects(listConsultants(deps, opA, { includeInactive: false }), (e: unknown) => e instanceof ForbiddenError);
  await assert.rejects(createConsultant(deps, opA, input(U.mktHead)), (e: unknown) => e instanceof ForbiddenError);
});
