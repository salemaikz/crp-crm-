// Одно правило просрочки (pipeline-v2 §4.3), тревога P8 и утренняя сводка: срок «день» на сегодня не просрочен,
// на следующие сутки просрочен; срок «время» считается с порогом.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runAlarms } from '../../../src/server/domain/notify/alarms';
import { runDigest } from '../../../src/server/domain/notify/digest';
import { overrideNotifyDepsForTests } from '../../../src/server/domain/notify/deps';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { cardOf } from '../../isolation/harness/seed';
import { DAY, HOUR, SEED_NOW, U, closeWorld, notificationsOf, openWorld, runInput, setCallback, system, useConfig } from './helpers';

let db: TestDb;
/** Начало местных суток 28.10.2026 (Алматы, UTC+5). */
const DAY_START = Date.UTC(2026, 9, 27, 19, 0);
const setDay = async (cardId: string, at: number) => {
  await setCallback(db.sql, cardId, at);
  await db.sql`UPDATE cards SET next_call_precision = 'day' WHERE id = ${cardId}`;
};
const managerDigest = async () => (await notificationsOf(db.sql, U.rop)).find((n) => n.kind === 'digest_manager');

before(async () => {
  db = await openWorld();
  useConfig();
  // срок «день» на сегодня 09:00 (на начало окна): по правилу «время» с порогом 60 мин он был бы просрочен
  await setDay(cardOf('a', 1), DAY_START + 9 * HOUR);
});
after(async () => {
  overrideNotifyDepsForTests(null);
  await closeWorld(db);
});

test('P8: карточка «день» на сегодня — тревоги нет', async () => {
  const r = await runAlarms(system(), runInput());
  assert.equal(r.overdueCallbacks, 0);
  assert.equal((await notificationsOf(db.sql, U.rop)).some((n) => n.kind === 'alarm_callbacks_overdue'), false);
});

test('утренняя сводка РОП: «день» на сегодня просрочку не растит', async () => {
  await runDigest(system(), runInput());
  const d = await managerDigest();
  assert.equal(d?.params.overdue ?? 0, 0);
});

test('утренняя сводка оператора считает сегодняшний срок «день» перезвоном на сегодня', async () => {
  const d = (await notificationsOf(db.sql, U.opA)).find((n) => n.kind === 'digest_operator');
  assert.equal(d?.params.callbacks, 1);
});

test('контроль: тот же срок по времени (не «день») просрочен по порогу', async () => {
  await setCallback(db.sql, cardOf('b', 1), DAY_START + 9 * HOUR); // precision 'time' по умолчанию
  const r = await runAlarms(system(), runInput());
  assert.equal(r.overdueCallbacks, 1);
});

test('на следующие сутки «день» просрочен: тревога и сводка считают обе карточки', async () => {
  const tomorrow = SEED_NOW + DAY; // 29.10 11:00
  const r = await runAlarms(system(tomorrow), runInput(tomorrow));
  assert.equal(r.overdueCallbacks, 2);
  await runDigest(system(tomorrow), runInput(tomorrow));
  const digests = (await notificationsOf(db.sql, U.rop)).filter((n) => n.kind === 'digest_manager');
  assert.equal(digests.at(-1)?.params.overdue, 2);
});

test('граница суток: «день» на вчера 23:59 не просрочен в 23:58 того же дня и просрочен с 00:00', async () => {
  await setDay(cardOf('b', 2), DAY_START - 60_000);
  const beforeMidnight = DAY_START - 2 * 60_000;
  assert.equal((await runAlarms(system(beforeMidnight), runInput(beforeMidnight))).overdueCallbacks, 0);
  const afterMidnight = DAY_START;
  assert.equal((await runAlarms(system(afterMidnight), runInput(afterMidnight))).overdueCallbacks, 1, 'остальные карточки «день»/«время» сегодняшние');
});
