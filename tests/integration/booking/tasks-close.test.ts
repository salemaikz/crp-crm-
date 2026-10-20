// Новая запись закрывает задачи клиента «записать» (D-204, PROCESS 6.2): оба вида, создание и перенос;
// импорт задач не трогает; другие клиенты и прочие источники не затронуты.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { systemActor } from '../../../src/server/access/systemActor';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U } from '../../isolation/harness/seed';
import { SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedEvent, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;

before(async () => {
  db = await openBookingWorld();
  deps = makeDeps({ now: SEED_NOW }, fakeCardPort());
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'tk-1', date: '2026-11-05', time: '15:00' });
  await seedEvent(db.sql, { id: 'tk-2', date: '2026-11-12', time: '15:00' });
});
after(() => closeWorld(db));

async function task(client: string, source: string, key: string | null = null): Promise<string> {
  const id = uuid();
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_at)
    VALUES (${id}, ${SPACE}, ${client}, 'call', ${source}, '', ${SEED_NOW + 3_600_000}, ${U.opA}, 'open', ${key}, ${SEED_NOW})`;
  return id;
}
const statusOf = async (id: string) => (await db.sql<{ status: string; doneAt: number | null }>`SELECT status, done_at FROM tasks WHERE id = ${id}`)[0]!;

test('запись на БР закрывает agreement:<opId> и прочие «записать»; callback и чужой клиент остаются', async () => {
  const op = uuid();
  const agreement = await task('cl-a-40', 'agreement', `agreement:${op}`);
  const rebook = await task('cl-a-40', 'rebook', `rebook:${op}`);
  const callback = await task('cl-a-40', 'callback');
  const foreign = await task('cl-a-41', 'agreement', `agreement:${uuid()}`);
  await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-40', eventId: 'tk-1', contactId: null });
  assert.deepEqual([(await statusOf(agreement)).status, (await statusOf(rebook)).status], ['done', 'done']);
  assert.equal((await statusOf(agreement)).doneAt, SEED_NOW);
  assert.equal((await statusOf(callback)).status, 'open', 'перезвон не «записать»');
  assert.equal((await statusOf(foreign)).status, 'open', 'задача другого клиента не тронута');
});

test('заявка на консультацию закрывает next_step у «Клиента»', async () => {
  await db.sql`UPDATE cards SET state = 'client' WHERE id = 'cd-a-42'`;
  const nextStep = await task('cl-a-42', 'next_step', `next_step:${uuid()}`);
  await createBooking(deps, opA, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-42', eventTypeKey: 'bk', date: '2026-10-29', time: '09:00', directionKey: 'marketing', resourceId: null, contactId: null });
  assert.equal((await statusOf(nextStep)).status, 'done');
});

test('перенос тоже закрывает задачи', async () => {
  await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-43', eventId: 'tk-1', contactId: null });
  const noShow = await task('cl-a-43', 'no_show', `no_show:${uuid()}`);
  const moved = await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-43', eventId: 'tk-2', contactId: null });
  assert.equal(moved.action, 'moved');
  assert.equal((await statusOf(noShow)).status, 'done');
});

test('импорт «Записи» задачи не закрывает', async () => {
  const open = await task('cl-a-44', 'clarify_import', `clarify:${uuid()}`);
  await createBooking(deps, systemActor('import', SEED_NOW), { kind: 'group', requestId: uuid(), clientId: 'cl-a-44', eventId: 'tk-1', contactId: null }, { imported: { importKey: `imp-${uuid()}`, bookedByUserId: null } });
  assert.equal((await statusOf(open)).status, 'open');
});

test('отказ записи (мест нет) задач не закрывает', async () => {
  const open = await task('cl-a-45', 'agreement', `agreement:${uuid()}`);
  await assert.rejects(createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-45', eventId: 'нет-такого', contactId: null }));
  assert.equal((await statusOf(open)).status, 'open');
});
