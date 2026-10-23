// Очередь «Звонить» и сводка РОП: срок «день» (pipeline-v2 §4.3). В очереди с начала окна; просрочка — со следующих суток.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getQueue } from '../../../src/server/domain/calls/queue';
import { getSummary } from '../../../src/server/domain/reports';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { overrideReportsDepsForTests } from '../../../src/server/domain/reports/deps';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { enterReportsConfig } from '../reports/helpers';
import { DAY, HOUR, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };
const DAY_START = Date.UTC(2026, 9, 27, 19, 0);
const ask = () => getQueue(deps, opA, { limit: 4, exclude: [], group: 'all' });

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  // «день» на сегодня с начала окна 09:00 и «день» на сегодня позже текущего момента — окно ещё не началось
  await setCard(db.sql, 'cd-a-1', { state: 'callback', nextCallAt: DAY_START + 9 * HOUR });
  await db.sql`UPDATE cards SET next_call_precision = 'day' WHERE id = 'cd-a-1'`;
  await setCard(db.sql, 'cd-a-2', { state: 'callback', nextCallAt: DAY_START + 9 * HOUR });
});
after(() => closeCallsWorld(db));

test('очередь: «день» с начала окна виден и не просрочен, «время» на тот же час просрочено по порогу', async () => {
  const r = await ask();
  assert.deepEqual(r.items.map((i) => i.cardId).sort(), ['cd-a-1', 'cd-a-2']);
  assert.equal(r.counts.overdue, 1);
});

test('очередь на следующие сутки: «день» просрочен', async () => {
  clock.now = SEED_NOW + DAY;
  try {
    assert.equal((await ask()).counts.overdue, 2);
  } finally {
    clock.now = SEED_NOW;
  }
});

test('сводка РОП: «Просроченные перезвоны» по тому же правилу', async () => {
  const rop = await viewerOf(U.rop);
  const cfg = { overdueAlertMinutes: 60 };
  const summaryAt = async (now: number) => {
    enterReportsConfig({ now }, cfg);
    try {
      return (await getSummary(rop)).tiles.overdue.cards;
    } finally {
      overrideReportsDepsForTests(null);
    }
  };
  // в мире изоляции есть и другие просроченные карточки: сравниваем разницу между «день» и «время»
  const today = await summaryAt(SEED_NOW);
  await db.sql`UPDATE cards SET next_call_precision = 'time' WHERE id = 'cd-a-1'`;
  const asTime = await summaryAt(SEED_NOW);
  assert.equal(asTime - today, 1, 'карточка «день» на сегодня не входит в просрочку, та же по времени — входит');
  await db.sql`UPDATE cards SET next_call_precision = 'day' WHERE id = 'cd-a-1'`;
  const tomorrow = await summaryAt(SEED_NOW + DAY);
  assert.equal(tomorrow - today >= 1, true, 'на следующие сутки «день» входит в просрочку');
});
