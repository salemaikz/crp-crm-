// Чужое пространство не входит в отчёты за период и панель директора: добавляем второе пространство со звонками, итогами,
// записями и сделками «на этой неделе» и сверяем ответы до и после. Только синтетика (+7 709 …).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getDirectorDashboard, getReport, getSummary } from '../../../src/server/domain/reports';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SEED_TODAY, U, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedCall, viewerOf, MIN } from './helpers';
import { FOREIGN_AMOUNT, FOREIGN_MARK, FOREIGN_SPACE, FOREIGN_USERS, seedForeignSpace } from './foreignSpace';

let db: TestDb;
const clock = { now: SEED_NOW };
const PERIOD = { from: '2026-10-26', to: SEED_TODAY };
const F = { userIds: null, sourceKey: null };

async function snapshot(userId: string) {
  const v = await viewerOf(userId);
  const reports = [
    await getReport(v, { key: 'operators', period: PERIOD, filters: F, grouping: 'day' }),
    await getReport(v, { key: 'funnel', period: PERIOD, filters: F, by: 'operator' }),
    await getReport(v, { key: 'funnel', period: PERIOD, filters: F, by: 'source' }),
    await getReport(v, { key: 'revenue', period: PERIOD, filters: F }),
    await getReport(v, { key: 'attendance', period: PERIOD, filters: F, by: 'event_type' }),
    await getReport(v, { key: 'attendance', period: PERIOD, filters: F, by: 'consultant' }),
    await getReport(v, { key: 'reasons', period: PERIOD, filters: F }),
  ];
  return JSON.stringify({ reports, director: await getDirectorDashboard(v), summary: await getSummary(v) });
}

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  // свои итоги, чтобы отчёты не были пустыми
  await seedCall(db.sql, { id: 'own1', cardId: 'cd-a-2', clientId: 'cl-a-2', userId: U.opA, at: SEED_NOW - 2 * 60 * MIN, kind: 'agreed' });
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

test('отчёты за период и панель директора не считают данные другого пространства', async () => {
  const before = { dir: await snapshot(U.director), rop: await snapshot(U.rop) };
  assert.ok((await getDirectorDashboard(await viewerOf(U.director))).calls.outcomes >= 1, 'контроль: свои итоги в отчёте есть');
  const world = await seedForeignSpace(db.sql);
  // контроль: чужие данные лежат в самом периоде — без отсечения по пространству они изменили бы числа
  const inPeriod = await db.sql<{ calls: number; won: string }>`
    SELECT (SELECT count(*) FROM calls WHERE space_id = ${FOREIGN_SPACE} AND occurred_at > ${SEED_NOW - 24 * 60 * MIN})::int AS calls,
           (SELECT COALESCE(sum(amount_kzt), 0) FROM deals WHERE space_id = ${FOREIGN_SPACE} AND status = 'won')::text AS won`;
  assert.ok(inPeriod[0]!.calls >= 5);
  assert.equal(Number(inPeriod[0]!.won), 5 * FOREIGN_AMOUNT);
  const after = { dir: await snapshot(U.director), rop: await snapshot(U.rop) };
  assert.equal(after.dir, before.dir, 'директор: числа изменились после появления чужого пространства');
  assert.equal(after.rop, before.rop, 'РОП: числа изменились после появления чужого пространства');
  // и в самих ответах нет чужих сотрудников, id и названий
  for (const body of [after.dir, after.rop]) {
    for (const id of FOREIGN_USERS) assert.ok(!body.includes(id), id);
    assert.ok(!body.includes(FOREIGN_MARK) && !body.includes(String(FOREIGN_AMOUNT)));
    for (const text of world.texts) assert.ok(!body.includes(text), text);
  }
});
