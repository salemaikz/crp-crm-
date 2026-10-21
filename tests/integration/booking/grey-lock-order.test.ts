// Порядок блокировок итога звонка против автоназначения «серых» (D-251, D-301): итог с отменой записей
// (`cancel_future`) берёт день консультаций клиента до строк задач. Иначе цикл: итог держит задачу
// `grey_unassigned:<id>` и ждёт день, а прогон `grey-assign` держит день и закрывает ту же задачу — 40P01.
// Прогон здесь воспроизведён его шагами (день → закрыть задачу по ключу), чтобы порядок был детерминирован.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { calling } from '../../../packages/core/src';
import { systemActor } from '../../../src/server/access/systemActor';
import { lockConsultDay } from '../../../src/server/domain/booking/consultDay';
import { greyTaskKey } from '../../../src/server/domain/booking/reserve';
import { applyCardEffects } from '../../../src/server/domain/cards/effects';
import type { CallingContext, EffectCard } from '../../../src/server/domain/cards/types';
import { closeAutoTaskByKey, ensureAutoTask } from '../../../src/server/domain/tasks/auto';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, SPACE, closeConsultWorld, insertGrey, openConsultWorld } from './helpers';

const TODAY = '2026-10-28';
let db: TestDb;

before(async () => {
  db = await openConsultWorld({ mode: 'assign' });
});
after(() => closeConsultWorld(db));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** Есть ли в этой базе процесс, ждущий advisory-блокировку (итог звонка встал на дне). */
async function advisoryWaiters(): Promise<number> {
  const rows = await db.sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
     WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`;
  return rows[0]!.n;
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`не дождались: ${what}`);
}

test('итог с отменой записей и прогон «серых» одновременно: без 40P01, задача закрыта, запись отменена', async () => {
  const client = 'cl-a-70';
  const bookingId = await insertGrey(db.sql, { id: 'gl1', client, card: 'cd-a-70', date: TODAY, time: '16:00' });
  const sys = systemActor('grey-assign@sales', SEED_NOW);
  await ensureAutoTask(db.sql, sys, {
    spaceId: SPACE,
    clientId: client,
    source: 'grey_unassigned',
    kind: 'check',
    assigneeUserId: U.rop,
    dueAt: SEED_NOW + 3_600_000,
    sourceKey: greyTaskKey(bookingId),
    at: SEED_NOW,
  });

  // «Не целевой»: ядро закрывает все задачи клиента и отменяет будущие записи
  const effects: calling.Effects = {
    tasks: [{ op: 'close', sources: 'all' }],
    deals: [],
    bookings: [{ op: 'cancel_future', reason: 'not_target' }],
    stopList: [],
    assignLog: [],
    notifications: [],
    timeline: [],
    audit: [],
    skips: [],
  };
  const card: EffectCard = { id: 'cd-a-70', clientId: client, spaceId: SPACE, ownerUserId: U.opA, actingUserId: null, phoneDigits: new Map() };
  const ctx = { calendar: { localDay: () => TODAY } } as unknown as CallingContext;

  const dayHeld = deferred();
  const goOn = deferred();
  // Прогон «серых»: держит день, затем закрывает задачу заявки (как после назначения консультанта)
  const grey = db.tx(async (tx) => {
    await lockConsultDay(tx, SPACE, TODAY);
    dayHeld.resolve();
    await goOn.promise;
    return closeAutoTaskByKey(tx, sys, { sourceKey: greyTaskKey(bookingId), at: SEED_NOW });
  });
  await dayHeld.promise;
  const outcome = db.tx((tx) => applyCardEffects(tx, systemActor('test', SEED_NOW), card, effects, SEED_NOW, ctx));
  await waitFor(async () => (await advisoryWaiters()) > 0, 'итог звонка ждёт день консультаций');
  goOn.resolve();

  const [g, o] = await Promise.allSettled([grey, outcome]);
  const codeOf = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? ((r.reason as { code?: string }).code ?? String(r.reason)) : 'ok');
  assert.deepEqual([codeOf(g), codeOf(o)], ['ok', 'ok'], 'ни одна сторона не получила 40P01');
  assert.equal(g.status === 'fulfilled' ? g.value : null, 1, 'задачу закрыл прогон: итог её ещё не трогал');

  const b = await db.sql<{ status: string }>`SELECT status FROM bookings WHERE id = ${bookingId}`;
  assert.equal(b[0]!.status, 'cancelled');
  const t = await db.sql<{ status: string }>`SELECT status FROM tasks WHERE source_key = ${greyTaskKey(bookingId)}`;
  assert.deepEqual(t.map((x) => x.status), ['done']);
});
