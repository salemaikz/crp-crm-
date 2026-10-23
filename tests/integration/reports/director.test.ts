// Панель директора (R4, D-265): числа недели и прошлой недели, запас, права и маршрут. Только синтетика.
// Блокировку мутаций директору (423) проверяет прогон изоляции: tests/isolation/runner/runner.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as directorRoute from '../../../src/app/api/reports/director/route';
import { ForbiddenError } from '../../../src/server/access';
import { getDirectorDashboard, getSummary, stockDays } from '../../../src/server/domain/reports';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { DAY, MIN, SEED_NOW, SEED_TODAY, U, actAs, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedCall, seedPool, viewerOf } from './helpers';

let db: TestDb;
let base: Awaited<ReturnType<typeof getDirectorDashboard>>; // числа мира изоляции до собственных звонков
const clock = { now: SEED_NOW };

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  await seedPool(db.sql, 20);
  base = await getDirectorDashboard(await viewerOf(U.director));
  // Эта неделя (пн 26.10 … ср 28.10): два итога A, один из них дозвон; прошлая неделя: один итог 22.10
  await seedCall(db.sql, { id: 'd1', cardId: 'cd-a-2', clientId: 'cl-a-2', userId: U.opA, at: SEED_NOW - 2 * 60 * MIN, kind: 'no_answer' });
  await seedCall(db.sql, { id: 'd2', cardId: 'cd-a-3', clientId: 'cl-a-3', userId: U.opA, at: SEED_NOW - 90 * MIN, kind: 'agreed' });
  await seedCall(db.sql, { id: 'd3', cardId: 'cd-a-4', clientId: 'cl-a-4', userId: U.opA, at: SEED_NOW - 6 * DAY, kind: 'agreed' });
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

test('итог с канала board увеличивает итоги, но не дозвоны', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  await seedCall(db.sql, { id: 'd4', cardId: 'cd-a-5', clientId: 'cl-a-5', userId: U.opA, at: SEED_NOW - 30 * MIN, kind: 'agreed', via: 'board' });
  const after = await getDirectorDashboard(v);
  assert.equal(after.calls.outcomes, before.calls.outcomes + 1);
  assert.equal(after.calls.connects, before.calls.connects);
  assert.equal(typeof after.calls.prevConnects, 'number');
  assert.deepEqual(Object.keys(after.eventLabels).sort(), ['group', 'individual']);
  await db.sql`DELETE FROM calls WHERE id = 'd4'`;
});

test('stockDays: один знак, нулевая ёмкость — null', () => {
  assert.equal(stockDays(20, 80), 0.3);
  assert.equal(stockDays(100, 40), 2.5);
  assert.equal(stockDays(10, 0), null);
});

test('директор: неделя, прошлая неделя, запас', async () => {
  const v = await viewerOf(U.director);
  const d = await getDirectorDashboard(v);
  assert.deepEqual([d.week.from, d.week.to], ['2026-10-26', SEED_TODAY]);
  assert.deepEqual([d.prevWeek.from, d.prevWeek.to], ['2026-10-19', '2026-10-25']);
  assert.equal(d.generatedAt, SEED_NOW);
  assert.equal(d.calls.outcomes, base.calls.outcomes + 2);
  assert.equal(d.calls.connects, base.calls.connects + 1);
  assert.equal(d.calls.prevOutcomes, base.calls.prevOutcomes + 1);
  assert.equal(d.funnel.counts.connected, base.funnel.counts.connected + 1);
  assert.deepEqual(d.revenue, base.revenue);
  assert.equal(d.purchases.count, base.purchases.count);
  // запас согласован с плитками сводки РОП
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(d.stock.poolReady, s.tiles.pool.ready);
  assert.equal(d.stock.capacityPerDay, s.tiles.issued.cap);
  assert.equal(d.stock.days, stockDays(s.tiles.pool.ready, s.tiles.issued.cap));
});

test('РОП тоже видит панель; оператор — 403', async () => {
  assert.equal((await getDirectorDashboard(await viewerOf(U.rop))).calls.outcomes, base.calls.outcomes + 2);
  await assert.rejects(getDirectorDashboard(await viewerOf(U.opA)), ForbiddenError);
});

test('маршрут: директору 200 без кэша; оператору 403; без сессии 401', async () => {
  const call = () => directorRoute.GET(new Request('http://crm.test/api/reports/director', { headers: { host: 'crm.test' } }), { params: Promise.resolve({}) });
  actAs(U.director);
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(((await ok.json()) as { calls: { outcomes: number } }).calls.outcomes, base.calls.outcomes + 2);
  actAs(U.opA);
  assert.equal((await call()).status, 403);
  actAs(null);
  assert.equal((await call()).status, 401);
});
