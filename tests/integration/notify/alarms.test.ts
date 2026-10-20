// Тревоги РОП: просроченные перезвоны по карточкам (D-050), непринятая передача, «серые» БК; суточный ключ и обновление.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { alarmsJob } from '../../../src/server/domain/notify/job';
import { runAlarms } from '../../../src/server/domain/notify/alarms';
import { overrideNotifyDepsForTests } from '../../../src/server/domain/notify/deps';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { FX, cardOf, clientOf } from '../../isolation/harness/seed';
import { DAY, HOUR, MIN, SEED_NOW, SEED_TODAY, U, calendar, closeWorld, countAll, notificationsOf, openWorld, runInput, seedGrey, setCallback, system, useConfig } from './helpers';

let db: TestDb;
const alarm = async (kind: string) => (await notificationsOf(db.sql, U.rop)).find((n) => n.kind === kind);

before(async () => {
  db = await openWorld();
  useConfig();
  await setCallback(db.sql, cardOf('a', 1), SEED_NOW - 3 * HOUR);
  await setCallback(db.sql, cardOf('b', 1), SEED_NOW - 90 * MIN);
  await setCallback(db.sql, cardOf('b', 2), SEED_NOW - 30 * MIN); // ещё не просрочен по порогу 60 мин
  await db.sql`UPDATE handoffs SET due_at = ${SEED_NOW - HOUR}::bigint WHERE id = ${FX.handoffLive.handoff}`;
  await seedGrey(db.sql, { id: 'bk-grey-old', cardId: cardOf('a', 1), clientId: clientOf('a', 1), day: SEED_TODAY, startsAt: SEED_NOW + 4 * HOUR, createdAt: SEED_NOW - HOUR, responsible: U.opA });
  await seedGrey(db.sql, { id: 'bk-grey-new', cardId: cardOf('a', 2), clientId: clientOf('a', 2), day: SEED_TODAY, startsAt: SEED_NOW + 5 * HOUR, createdAt: SEED_NOW - 5 * MIN, responsible: U.opA });
});
after(async () => {
  overrideNotifyDepsForTests(null);
  await closeWorld(db);
});

test('три тревоги РОП с числами; порог просрочки и ожидание «серой» соблюдены', async () => {
  const r = await runAlarms(system(), runInput());
  assert.deepEqual({ ...r }, { overdueCallbacks: 2, handoffs: 1, grey: 1, written: 3 });
  assert.deepEqual((await alarm('alarm_callbacks_overdue'))?.params, { count: 2, operators: 2 });
  assert.deepEqual((await alarm('alarm_handoff_unaccepted'))?.params, { count: 1 });
  assert.deepEqual((await alarm('alarm_grey_unassigned'))?.params, { count: 1 });
});

test('тревоги получает только РОП: операторы и директор — нет', async () => {
  for (const u of [U.opA, U.opB, U.duty, U.director, U.consultant, U.disabled]) assert.equal((await notificationsOf(db.sql, u)).length, 0, u);
});

test('повтор в тот же час ничего не меняет; число выросло — непрочитанная тревога обновилась', async () => {
  const total = await countAll(db.sql);
  assert.equal((await runAlarms(system(), runInput())).written, 0);
  await setCallback(db.sql, cardOf('b', 3), SEED_NOW - 2 * HOUR);
  const later = SEED_NOW + 10 * MIN;
  assert.equal((await runAlarms(system(later), runInput(later))).written, 1);
  assert.equal(await countAll(db.sql), total, 'новых строк нет: обновилась суточная');
  assert.deepEqual((await alarm('alarm_callbacks_overdue'))?.params, { count: 3, operators: 2 });
});

test('прочитанная тревога за день не воскресает; на следующий день — новая', async () => {
  await db.sql`UPDATE notifications SET read_at = ${SEED_NOW}::bigint WHERE user_id = ${U.rop} AND kind = 'alarm_callbacks_overdue'`;
  await setCallback(db.sql, cardOf('b', 4), SEED_NOW - 2 * HOUR);
  const later = SEED_NOW + 20 * MIN;
  await runAlarms(system(later), runInput(later));
  const rows = (await notificationsOf(db.sql, U.rop)).filter((n) => n.kind === 'alarm_callbacks_overdue');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.params.count, 3, 'прочитанная осталась как была');
  assert.notEqual(rows[0]?.readAt, null);

  const tomorrow = SEED_NOW + DAY;
  await runAlarms(system(tomorrow), runInput(tomorrow));
  const after2 = (await notificationsOf(db.sql, U.rop)).filter((n) => n.kind === 'alarm_callbacks_overdue');
  assert.equal(after2.length, 2);
});

test('нет повода — нет тревог', async () => {
  await db.sql`UPDATE cards SET state = 'retry', next_call_at = NULL WHERE state = 'callback'`;
  await db.sql`UPDATE handoffs SET status = 'accepted'`;
  await db.sql`UPDATE bookings SET resource_id = 'rs-cons' WHERE resource_id IS NULL`;
  const before2 = await countAll(db.sql);
  const later = SEED_NOW + 2 * DAY;
  const r = await runAlarms(system(later), runInput(later));
  assert.deepEqual({ ...r }, { overdueCallbacks: 0, handoffs: 0, grey: 0, written: 0 });
  assert.equal(await countAll(db.sql), before2);
});

test('задача воркера: обёртка над runAlarms возвращает числа без ПДн', async () => {
  const logs: string[] = [];
  const result = await alarmsJob.handler({
    actor: system(),
    runId: 'run-1',
    slot: { key: `${SEED_TODAY}T09:00`, at: SEED_NOW },
    attempt: 1,
    now: SEED_NOW,
    signal: new AbortController().signal,
    space: { id: 'sp-sales', key: 'sales' },
    calendar,
    log: { info: (code) => logs.push(code), warn: (code) => logs.push(code) },
  });
  assert.equal(result.status, 'ok');
  assert.ok(Object.values(result.stats).every((v) => typeof v === 'number'));
  assert.deepEqual(logs, ['alarms.done']);
});
