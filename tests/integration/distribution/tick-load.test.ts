// Нагрузка тика (Q1c): 10 операторов, 5 000 карточек в пуле, 400 выдач за тик — не дольше 5 секунд.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { runTick } from '../../../src/server/domain/distribution/tick';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, closeWorld, logCount, makeDeps, openDistributionWorld, poolOwnership, seedPool, system, tickInput, type Clock } from './helpers';

const LIMIT_MS = 5000;
let db: TestDb;
const clock: Clock = { now: SEED_NOW };

before(async () => {
  db = await openDistributionWorld();
  // к трём операторам синтетики добавляем ещё семь: всего десять участников
  for (let i = 1; i <= 7; i++) {
    await db.sql`INSERT INTO users (id, phone_digits, name, status, created_at) VALUES (${`u-load-${i}`}, ${`77099500${String(i).padStart(3, '0')}`}, ${`Оператор Нагрузка ${i}`}, 'active', ${SEED_NOW})`;
    await db.sql`INSERT INTO memberships (user_id, space_id, role_key, in_distribution, created_at, updated_at) VALUES (${`u-load-${i}`}, ${SPACE}, 'operator', TRUE, ${SEED_NOW}, ${SEED_NOW})`;
  }
  await seedPool(db.sql, 5000);
});
after(async () => closeWorld(db));

test('тик на 10 операторов и 5 000 карточек: 400 выдач за ≤ 5 с', async () => {
  const t0 = Date.now();
  const r = await runTick(system(), tickInput(clock), makeDeps(clock));
  const took = Date.now() - t0;
  assert.equal(r.status, 'done');
  assert.equal(r.assigned, 400);
  assert.ok(took <= LIMIT_MS, `тик занял ${took} мс при пределе ${LIMIT_MS}`);
  assert.equal(await logCount(db.sql, 'auto'), 400);
  const own = await poolOwnership(db.sql);
  assert.equal(own[''], 4600);
  assert.equal(Object.keys(r.issued).length, 10);
  assert.ok(Object.values(r.issued).every((n) => n === 40));
});
