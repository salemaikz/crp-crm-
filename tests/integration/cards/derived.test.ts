// Кэш признаков и горячести (C5, pipeline-v2 §5.1): пересчёт из записей и выигранных сделок, `version` и `updated_at` не
// меняются, повтор идемпотентен, исправление явки и отмена покупки дают верный результат, запись карточки пересчитывает
// кэш в своей транзакции, пачечное задание пропускает занятые строки и не пересчитывает без смены весов.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { calling } from '@crm/core';
import { systemActor } from '../../../src/server/access/systemActor';
import type { Viewer } from '../../../src/server/access/types';
import { loadBoardSettings } from '../../../src/server/domain/cards/boardSettings';
import { derivedOf, refreshCardDerived } from '../../../src/server/domain/cards/derived';
import { selectDerivedSources } from '../../../src/server/domain/cards/derivedRepo';
import { heatRecomputeJob, heatStateFingerprint, recomputeSpaceHeat } from '../../../src/server/domain/cards/heatJob';
import { reopenCard } from '../../../src/server/domain/cards/menu';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { jsonParam } from '../../../src/server/platform/db/core';
import { createPostgresDb } from '../../../src/server/platform/db/postgres';
import type { JobContext } from '../../../src/server/platform/jobs';
import { U, cardOf, clientOf } from '../../isolation/harness/seed';
import { DAY, SEED_NOW, SPACE, addCard, closeBoardWorld, openBoardWorld } from './boardWorld';
import { viewerOf } from '../../isolation/harness/actors';

let db: TestDb;
let rop: Viewer;
const actor = () => systemActor('test.derived', SEED_NOW);

before(async () => {
  db = await openBoardWorld();
  rop = await viewerOf(U.rop);
});
after(() => closeBoardWorld(db));

interface Row {
  version: number;
  updatedAt: number;
  heat: number;
  attendedGroupAt: number | null;
  attendedIndividualAt: number | null;
  lastNoShowAt: number | null;
  lastNoShowKind: string;
  purchasesTotal: number;
  lastPurchaseAt: number | null;
}
const row = async (id: string): Promise<Row> =>
  (await db.sql<Row>`SELECT version, updated_at, heat, attended_group_at, attended_individual_at, last_no_show_at, last_no_show_kind, purchases_total, last_purchase_at FROM cards WHERE id = ${id}`)[0]!;
const refresh = (ids: string[]) => db.tx((tx) => refreshCardDerived(actor(), tx, ids));

/** Запись клиента карточки `a`: вид, статус, момент. */
async function booking(id: string, cardId: string, clientId: string, kind: 'group' | 'individual', status: string, startsAt: number, event = 'ev-today'): Promise<void> {
  const group = kind === 'group';
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, booking_date, start_time, starts_at, duration_min, status, created_at, updated_at)
               VALUES (${id}, ${SPACE}, ${kind}, ${group ? 'group' : 'consult'}, ${group ? event : null}, ${group ? null : 'rs-cons'}, ${clientId}, ${cardId}, '2026-10-20', '10:00',
                       ${startsAt}, 60, ${status}, ${startsAt}, ${startsAt})`;
}
async function wonDeal(id: string, cardId: string, clientId: string, wonAt: number, status = 'won'): Promise<void> {
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, won_at, stage_changed_at, created_at, updated_at)
               VALUES (${id}, ${SPACE}, 'sales', 'paid', ${status}, ${clientId}, ${cardId}, ${U.opA}, ${status === 'won' ? wonAt : null}, ${wonAt}, ${wonAt}, ${wonAt})`;
}

test('признаки из записей и сделок, горячесть ядром; version и updated_at не меняются; повтор ничего не меняет', async () => {
  const id = cardOf('a', 10);
  const client = clientOf('a', 10);
  await db.sql`UPDATE cards SET state = 'callback', callback_reason = 'think', lpr = 'yes', next_call_at = ${SEED_NOW + DAY} WHERE id = ${id}`;
  await booking('dv-g1', id, client, 'group', 'attended', SEED_NOW - 9 * DAY);
  await booking('dv-g0', id, client, 'group', 'attended', SEED_NOW - 20 * DAY, 'ev-tomorrow');
  await booking('dv-i1', id, client, 'individual', 'no_show', SEED_NOW - 3 * DAY);
  await booking('dv-c1', id, client, 'individual', 'cancelled', SEED_NOW - 1 * DAY);
  await wonDeal('dv-w1', id, client, SEED_NOW - 30 * DAY);
  await wonDeal('dv-w2', id, client, SEED_NOW - 7 * DAY);
  await wonDeal('dv-l1', id, client, SEED_NOW - 2 * DAY, 'lost').catch(() => undefined);
  const before1 = await row(id);

  assert.ok((await refresh([id])) >= 1);
  const r = await row(id);
  assert.equal(r.attendedGroupAt, SEED_NOW - 9 * DAY, 'последняя явка на групповое');
  assert.equal(r.attendedIndividualAt, null);
  assert.equal(r.lastNoShowAt, SEED_NOW - 3 * DAY);
  assert.equal(r.lastNoShowKind, 'individual');
  assert.equal(r.purchasesTotal, 2);
  assert.equal(r.lastPurchaseAt, SEED_NOW - 7 * DAY);
  const w = (await loadBoardSettings(SPACE)).heat;
  const expected = calling.heatOf(
    { state: 'callback', callbackReason: 'think', lpr: 'yes', attendedGroupAt: r.attendedGroupAt, attendedIndividualAt: null, lastNoShowAt: r.lastNoShowAt, purchasesTotal: 2, nextCallAt: SEED_NOW + DAY, nextCallPrecision: 'time' },
    w,
  );
  assert.ok(expected > 0);
  assert.equal(r.heat, expected);
  assert.equal(r.version, before1.version, 'version не тронут');
  assert.equal(r.updatedAt, before1.updatedAt, 'updated_at не тронут');

  assert.equal(await refresh([id]), 0, 'повтор: нечего писать');
  assert.deepEqual(await row(id), r);

  // исправление явки (статус записи) и отмена покупки дают верный результат: пересчёт из источника, не приращение
  await db.sql`UPDATE bookings SET status = 'cancelled' WHERE id = 'dv-g1'`;
  await db.sql`UPDATE deals SET status = 'lost', won_at = NULL, lost_at = ${SEED_NOW} WHERE id = 'dv-w2'`;
  await refresh([id]);
  const r2 = await row(id);
  assert.equal(r2.attendedGroupAt, SEED_NOW - 20 * DAY);
  assert.equal(r2.purchasesTotal, 1);
  assert.equal(r2.lastPurchaseAt, SEED_NOW - 30 * DAY);
  assert.equal(r2.version, before1.version);
});

test('derivedOf: закрытые и «Договорились» всегда 0; чужие записи другого клиента не учитываются', async () => {
  const w = (await loadBoardSettings(SPACE)).heat;
  const src = (await db.tx((tx) => selectDerivedSources(actor(), tx, [cardOf('a', 10)])))[0]!;
  assert.equal(derivedOf({ ...src, state: 'agreed' }, w).heat, 0);
  assert.equal(derivedOf({ ...src, state: 'not_target' }, w).heat, 0);
  const other = cardOf('a', 11);
  await refresh([other]);
  const o = await row(other);
  assert.deepEqual([o.attendedGroupAt, o.purchasesTotal, o.lastPurchaseAt], [null, 0, null]);
});

test('запись карточки пересчитывает кэш в своей транзакции без лишнего роста version', async () => {
  const id = cardOf('a', 12);
  await db.sql`UPDATE cards SET state = 'written_off', closed_at = ${SEED_NOW - DAY}, close_reason_code = 'unreachable', heat = 0 WHERE id = ${id}`;
  const v0 = (await row(id)).version;
  const res = await reopenCard(rop, id, { opId: crypto.randomUUID(), version: v0, comment: 'Клиент перезвонил сам' });
  assert.equal(res.state, 'callback');
  const r = await row(id);
  assert.equal(r.version, res.version, 'version вырос ровно на запись карточки');
  const w = (await loadBoardSettings(SPACE)).heat;
  assert.equal(r.heat, w.states.callback ?? 0, 'горячесть пересчитана после записи (вес состояния «перезвон»)');
  assert.ok(r.heat > 0);
});

test('пачечный пересчёт: все карточки пространства, идемпотентно, занятая строка пропускается', async () => {
  await db.sql`UPDATE cards SET heat = 12345 WHERE space_id = ${SPACE} AND id LIKE 'cd-b-%'`;
  const r1 = await recomputeSpaceHeat(actor(), { spaceId: SPACE, batch: 7 });
  assert.ok(r1.cards >= 200, 'пройдены все карточки пространства');
  assert.ok(r1.changed >= 100, 'испорченный кэш исправлен');
  assert.equal((await db.sql`SELECT 1 FROM cards WHERE id LIKE 'cd-b-%' AND heat = 12345`).length, 0);
  assert.equal((await recomputeSpaceHeat(actor(), { spaceId: SPACE, batch: 7 })).changed, 0, 'повтор идемпотентен');

  // карточку держит другая транзакция: пачка её пропускает (её запись сама пересчитает кэш)
  const target = cardOf('b', 20);
  await db.sql`UPDATE cards SET heat = 777 WHERE id = ${target}`;
  // Вторая пара соединений: вложенный db.tx работал бы точкой сохранения той же транзакции, а нужна чужая транзакция
  const schema = (await db.sql<{ s: string }>`SELECT current_schema() AS s`)[0]!.s;
  const other = await createPostgresDb(process.env['TEST_DATABASE_URL']!, { schema });
  try {
    await other.tx(async (tx) => {
      await tx`SELECT id FROM cards WHERE id = ${target} FOR UPDATE`;
      const r = await recomputeSpaceHeat(actor(), { spaceId: SPACE, batch: 50 });
      assert.ok(r.cards > 0);
    });
  } finally {
    await other.close();
  }
  assert.equal((await row(target)).heat, 777, 'занятая строка пропущена');
  await recomputeSpaceHeat(actor(), { spaceId: SPACE });
  assert.notEqual((await row(target)).heat, 777);
});

test('задание: полный прогон без истории; без смены весов — пропуск; другой отпечаток — прогон', async () => {
  const job = 'calling-heat-recompute@sales';
  const ctx = (): JobContext =>
    ({
      actor: systemActor(job, SEED_NOW),
      runId: 'r',
      slot: { key: 's', at: SEED_NOW },
      attempt: 1,
      now: SEED_NOW,
      signal: new AbortController().signal,
      space: { id: SPACE, key: 'sales' },
      log: { info: () => undefined, warn: () => undefined },
    }) as unknown as JobContext;
  const first = await heatRecomputeJob.handler(ctx());
  assert.equal(first.status, 'ok');
  assert.equal(first.stats['full'], 1);
  assert.equal(first.stats['fp'], await heatStateFingerprint(SPACE));
  const log = async (slot: string, fp: number, finishedAt: number) =>
    db.sql`INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at, finished_at, stats) VALUES (${slot}, ${job}, ${slot}, 'ok', 1, ${finishedAt - 1000}, ${finishedAt}, ${jsonParam({ fp, full: 1, cards: 1, changed: 0 })})`;
  await log('slot-1', first.stats['fp']!, SEED_NOW - 1000);
  const second = await heatRecomputeJob.handler(ctx());
  assert.equal(second.status, 'skipped');
  assert.equal(second.note, 'unchanged');
  // веса сменились: отпечаток прошлого прогона не совпадает
  await log('slot-2', first.stats['fp']! + 1, SEED_NOW - 500);
  assert.equal((await heatRecomputeJob.handler(ctx())).status, 'ok');
  // сутки без полного прогона: кэш сверяется заново, даже если веса те же
  await db.sql`DELETE FROM job_runs`;
  await log('slot-3', first.stats['fp']!, SEED_NOW - 25 * 3_600_000);
  assert.equal((await heatRecomputeJob.handler(ctx())).status, 'ok');
});

test('карточка без владельца-пользователя и без записей: кэш по умолчанию, пересчёт ничего не ломает', async () => {
  await addCard(db.sql, { id: 'dv-empty', owner: null, state: 'new' }, 900);
  assert.equal(await refresh(['dv-empty']), 1, 'вес состояния «новая» записан');
  assert.equal(await refresh(['dv-empty']), 0);
  assert.equal(await refresh([]), 0);
});
