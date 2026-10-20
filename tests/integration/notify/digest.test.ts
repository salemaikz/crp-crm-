// Утренняя сводка (PROCESS §11): оператору — свои перезвоны и записи на сегодня, РОП — просрочки и пул; идемпотентность.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runDigest } from '../../../src/server/domain/notify/digest';
import { overrideNotifyDepsForTests } from '../../../src/server/domain/notify/deps';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { cardOf, clientOf } from '../../isolation/harness/seed';
import { DAY, HOUR, SEED_NOW, SEED_TODAY, U, closeWorld, countAll, notificationsOf, openWorld, runInput, seedGrey, seedPool, setCallback, system, useConfig } from './helpers';

let db: TestDb;

before(async () => {
  db = await openWorld();
  useConfig();
  // A: просроченный (3 ч), сегодня вечером, завтра. B: просроченный. Остальные карточки мира — 'retry'.
  await setCallback(db.sql, cardOf('a', 1), SEED_NOW - 3 * HOUR);
  await setCallback(db.sql, cardOf('a', 2), SEED_NOW + 2 * HOUR);
  await setCallback(db.sql, cardOf('a', 3), SEED_NOW + DAY);
  await setCallback(db.sql, cardOf('b', 1), SEED_NOW - 90 * 60_000);
  // Запись A на сегодня и на завтра; у B записи мира — из синтетики
  await seedGrey(db.sql, { id: 'bk-a-today', cardId: cardOf('a', 1), clientId: clientOf('a', 1), day: SEED_TODAY, startsAt: SEED_NOW + 4 * HOUR, createdAt: SEED_NOW - DAY, responsible: U.opA });
  await seedGrey(db.sql, { id: 'bk-a-tomorrow', cardId: cardOf('a', 2), clientId: clientOf('a', 2), day: '2026-10-29', startsAt: SEED_NOW + DAY, createdAt: SEED_NOW - DAY, responsible: U.opA });
  await seedPool(db.sql, 3);
});
after(async () => {
  overrideNotifyDepsForTests(null);
  await closeWorld(db);
});

test('оператор получает свои числа: перезвоны до конца суток (с просроченными) и записи на сегодня', async () => {
  const report = await runDigest(system(), runInput());
  assert.ok(report.operators >= 3 && report.managers === 1);
  const [a] = await notificationsOf(db.sql, U.opA);
  assert.ok(a);
  assert.equal(a.kind, 'digest_operator');
  assert.deepEqual(a.params, { callbacks: 2, bookings: 1 });
  assert.equal(a.dedupeKey, `digest:${U.opA}:${SEED_TODAY}`);
  const [b] = await notificationsOf(db.sql, U.opB);
  assert.ok(b);
  assert.equal(b.params.callbacks, 1);
  const [row] = await db.sql<{ n: number }>`
    SELECT count(*)::int AS n FROM bookings WHERE responsible_user_id = ${U.opB} AND booking_date = ${SEED_TODAY} AND status IN ('registered','confirmed')`;
  assert.equal(b.params.bookings, row?.n);
});

test('пустую сводку не пишем; уволенному и не-оператору (консультант, директор) не шлём', async () => {
  assert.equal((await notificationsOf(db.sql, U.duty)).length, 0, 'у дежурного-оператора ничего нет');
  for (const u of [U.disabled, U.consultant, U.director, U.admin]) assert.equal((await notificationsOf(db.sql, u)).length, 0, u);
});

test('РОП получает просрочки и пул, без названий и номеров', async () => {
  const [r] = await notificationsOf(db.sql, U.rop);
  assert.ok(r);
  assert.equal(r.kind, 'digest_manager');
  // просрочены (срок раньше «сейчас»): карточки A1 и B1
  assert.deepEqual(r.params, { overdue: 2, pool: 3 });
});

test('повтор слота ничего не создаёт и не меняет', async () => {
  const before = await countAll(db.sql);
  const again = await runDigest(system(), runInput());
  assert.equal(again.created, 0);
  assert.equal(await countAll(db.sql), before);
  // слот следующего рабочего дня — новая сводка
  const next = await runDigest(system(SEED_NOW + DAY), runInput(SEED_NOW + DAY));
  assert.ok(next.created >= 3);
  assert.equal((await notificationsOf(db.sql, U.opA)).length, 2);
});
