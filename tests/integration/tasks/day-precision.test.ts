// Задача-проекция перезвона со сроком «день» (pipeline-v2 §4.3): просрочена только с начала следующих суток.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import { bucketOf, dayBounds } from '../../../src/server/domain/tasks/buckets';
import { listTasks } from '../../../src/server/domain/tasks';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, SEED_TODAY, SEED_TZ, SPACE, U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from '../clients/world';

let db: TestDb;
const DAY = 86_400_000;
const at = (day: string, hhmm: string) => time.fromLocalTime(day, hhmm, SEED_TZ);

before(async () => {
  db = await openClientsWorld();
  const mk = (id: string, n: number, due: number, precision: 'time' | 'day') =>
    db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_at, due_precision)
           VALUES (${id}, ${SPACE}, ${clientOf('a', n)}, 'call', 'callback', '', ${due}, ${U.opA}, 'open', ${`callback:${id}`}, ${SEED_NOW - DAY}, ${precision})`;
  await mk('tk-day-today', 21, at(SEED_TODAY, '09:00'), 'day'); // 09:00 уже прошло, но срок «день»
  await mk('tk-time-today', 22, at(SEED_TODAY, '09:00'), 'time');
  await mk('tk-day-yesterday', 23, at('2026-10-27', '09:00'), 'day');
});
after(() => closeClientsWorld(db));

const bucketsOf = async (now: number, today: string) => {
  enterSeedWorld({ now });
  const v = await viewerOf(U.opA);
  assert.equal(v.today, today);
  enterSeedWorld();
  const l = await listTasks(v, { view: 'mine' });
  return { by: Object.fromEntries(l.items.map((i) => [i.id, i.bucket])), counts: l.counts };
};

test('bucketOf: «день» на сегодня — «Сегодня», вчерашний — «Просрочено»; «время» — по прежнему правилу', () => {
  const b = dayBounds(SEED_NOW, SEED_TODAY, SEED_TZ);
  assert.equal(bucketOf(at(SEED_TODAY, '09:00'), 'day', b), 'today');
  assert.equal(bucketOf(at(SEED_TODAY, '09:00'), 'time', b), 'overdue');
  assert.equal(bucketOf(at('2026-10-27', '23:59'), 'day', b), 'overdue');
  assert.equal(bucketOf(null, 'day', b), 'none');
  assert.equal(bucketOf(at('2026-10-29', '09:00'), 'day', b), 'tomorrow');
});

test('экран задач: «день» на сегодня в «Сегодня», счётчики совпадают с корзинами', async () => {
  const { by, counts } = await bucketsOf(SEED_NOW, SEED_TODAY);
  assert.equal(by['tk-day-today'], 'today');
  assert.equal(by['tk-time-today'], 'overdue');
  assert.equal(by['tk-day-yesterday'], 'overdue');
  const listed = Object.values(by);
  assert.equal(counts.overdue, listed.filter((x) => x === 'overdue').length);
  assert.equal(counts.today, listed.filter((x) => x === 'today').length);
});

test('на следующие сутки «день» просрочен и в списке, и в счётчике', async () => {
  const { by, counts } = await bucketsOf(SEED_NOW + DAY, '2026-10-29');
  assert.equal(by['tk-day-today'], 'overdue');
  assert.equal(counts.overdue, Object.values(by).filter((x) => x === 'overdue').length);
});
