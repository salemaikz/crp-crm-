// Нагрузочный прогон Q1c (docs/PLAN.md, день 5): 5 000 карточек, 10 операторов, 400 выдач за тик раздачи.
// Критерии: тик ≤ 5 с; очередь оператора p95 ≤ 300 мс при 10 параллельных операторах; в Postgres нет дедлоков и
// ошибок блокировок. Не входит в test:integration (отдельная папка). Запуск и разбор — docs/ops/load-q1c.md. Только синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Viewer } from '../../src/server/access/types';
import { submitOutcome } from '../../src/server/domain/calls/outcomes';
import { getQueue } from '../../src/server/domain/calls/queue';
import { overrideDistributionDepsForTests } from '../../src/server/domain/distribution/deps';
import { runTick } from '../../src/server/domain/distribution/tick';
import type { TestDb } from '../../src/server/platform/db/testing';
import { MIN, SEED_NOW, SPACE, U, makeDeps, system, testConfig, tickInput, uuid } from '../integration/distribution/helpers';
import { callsDeps, closeCallsWorld, openCallsWorld, outcomeReq, viewerOf } from '../integration/calls/world';

const TICK_LIMIT_MS = 5000;
const QUEUE_P95_MS = 300;
const PG_LOG = process.env.PG_LOG_PATH ?? '/var/log/postgresql/postgresql-16-main.log';
const ROUNDS = 30; // итогов на оператора
const clock = { now: SEED_NOW };

let db: TestDb;
let operators: string[];
let viewers: Viewer[];
let deadlocks0 = 0;
let logPos0 = 0;

const deadlocks = async (): Promise<number> => {
  await new Promise((r) => setTimeout(r, 1500)); // статистика Postgres сбрасывается с задержкой
  const [r] = await db.sql<{ n: number }>`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`;
  return r?.n ?? 0;
};
const p = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1]!;

before(async () => {
  db = await openCallsWorld();
  const sql = db.sql;
  const t = SEED_NOW - 86_400_000;
  // 10 операторов: opA, opB, duty из мира и ещё 7 (участники раздачи)
  const extra = Array.from({ length: 7 }, (_, i) => `u-op-x${i + 1}`);
  operators = [U.opA, U.opB, U.duty, ...extra];
  for (const [i, id] of extra.entries()) {
    await sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at) VALUES (${id}, ${`7709800${String(i).padStart(4, '0')}`}, ${`Оператор Нагрузка ${i + 1}`}, FALSE, 'active', ${t})`;
    await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${id}, ${SPACE}, 'operator', NULL, TRUE, ${t}, ${t})`;
  }
  // 5 000 карточек = 200 из мира + 800 уже у операторов (по 80) + 4 000 в пуле
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            SELECT 'ql-' || i, 'company', 'ТОО Прогон ' || i, 'прогон ' || i, 'прогон ' || i, 'import', ${t}::bigint, ${t}::bigint FROM generate_series(1, 4800) AS i`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
            SELECT 'qp-' || i, 'ql-' || i, '77093' || lpad(i::text, 6, '0'), 'mobile', TRUE, ${t}::bigint FROM generate_series(1, 4800) AS i`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, assigned_at, created_at, updated_at)
            SELECT 'pc-' || i, ${SPACE}::text, 'ql-' || i, CASE WHEN i <= 800 THEN (${operators}::text[])[1 + i % 10] END,
                   'new', NULL, CASE WHEN i <= 800 THEN ${t}::bigint END, ${t}::bigint + i * 1000, ${t}::bigint + i * 1000
              FROM generate_series(1, 4800) AS i`;
  await sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at)
            SELECT 'qc-' || i, 'ql-' || i, 'Контакт ' || i, 'Директор', TRUE, ${t}::bigint FROM generate_series(1, 4800) AS i`;
  await sql`ANALYZE`;
  viewers = [];
  for (const id of operators) viewers.push(await viewerOf(id));
  if (existsSync(PG_LOG)) logPos0 = statSync(PG_LOG).size;
  deadlocks0 = await deadlocks();
});
after(async () => {
  overrideDistributionDepsForTests(null);
  await closeCallsWorld(db);
});

test('в мире ровно 5 000 карточек и 10 операторов раздачи', async () => {
  const [c] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM cards`;
  assert.equal(c!.n, 5000);
  assert.equal(operators.length, 10);
});

test(`тик раздачи: 400 выдач (10 × 40) за ≤ ${TICK_LIMIT_MS} мс`, async () => {
  overrideDistributionDepsForTests(makeDeps(clock, testConfig()));
  const t0 = performance.now();
  const r = await runTick(system(), tickInput(clock));
  const ms = performance.now() - t0;
  console.log(`# тик раздачи: ${ms.toFixed(0)} мс, выдано ${r.assigned}, статус ${r.status}`);
  assert.equal(r.status, 'done');
  assert.equal(r.assigned, 400);
  assert.ok(ms <= TICK_LIMIT_MS, `тик ${ms.toFixed(0)} мс при пределе ${TICK_LIMIT_MS}`);
  const [log] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM assign_log WHERE kind = 'auto'`;
  assert.equal(log!.n, 400);
});

test(`10 операторов параллельно: очередь и итоги, p95 очереди ≤ ${QUEUE_P95_MS} мс, 2-й тик идёт рядом`, async () => {
  const deps = callsDeps(clock);
  const queueMs: number[] = [];
  const outcomeMs: number[] = [];
  let outcomes = 0;
  const worker = async (v: Viewer): Promise<void> => {
    for (let i = 0; i < ROUNDS; i++) {
      const t0 = performance.now();
      const q = await getQueue(deps, v, { limit: 6, exclude: [], group: 'all' });
      queueMs.push(performance.now() - t0);
      const card = q.items[0];
      assert.ok(card, 'очередь не должна быть пустой');
      const t1 = performance.now();
      await submitOutcome(deps, v, outcomeReq({ cardId: card.cardId, outcomeKey: 'no_answer', occurredAt: SEED_NOW - MIN }));
      outcomeMs.push(performance.now() - t1);
      outcomes++;
    }
  };
  // Второй тик с лимитом 80 (ещё 400 выдач) идёт параллельно операторам: проверка блокировок «тик × итоги»
  overrideDistributionDepsForTests(makeDeps(clock, testConfig({ dailyCap: 80 })));
  const tickP = (async () => {
    const t0 = performance.now();
    const r = await runTick(system(), tickInput(clock, uuid()));
    return { ms: performance.now() - t0, r };
  })();
  await Promise.all([...viewers.map(worker), tickP]);
  const tick = await tickP;
  console.log(`# очередь (10 параллельно, ${queueMs.length} запросов): p50 ${p(queueMs, 0.5).toFixed(1)} мс, p95 ${p(queueMs, 0.95).toFixed(1)} мс, max ${Math.max(...queueMs).toFixed(1)} мс`);
  console.log(`# итог: p50 ${p(outcomeMs, 0.5).toFixed(1)} мс, p95 ${p(outcomeMs, 0.95).toFixed(1)} мс, max ${Math.max(...outcomeMs).toFixed(1)} мс; всего ${outcomes}`);
  console.log(`# параллельный тик: ${tick.ms.toFixed(0)} мс, выдано ${tick.r.assigned}`);
  assert.equal(outcomes, 10 * ROUNDS);
  assert.ok(p(queueMs, 0.95) <= QUEUE_P95_MS, `p95 очереди ${p(queueMs, 0.95).toFixed(1)} мс при пределе ${QUEUE_P95_MS}`);
  assert.ok(tick.ms <= TICK_LIMIT_MS, `параллельный тик ${tick.ms.toFixed(0)} мс`);
  const [c] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE card_id LIKE 'pc-%'`;
  assert.equal(c!.n, 10 * ROUNDS);
});

test('в Postgres нет дедлоков и ошибок блокировок', async () => {
  const d = (await deadlocks()) - deadlocks0;
  console.log(`# дедлоков по pg_stat_database за прогон: ${d}`);
  assert.equal(d, 0);
  if (!existsSync(PG_LOG)) {
    console.log(`# журнал Postgres ${PG_LOG} недоступен — проверка по логу пропущена (только pg_stat_database)`);
    return;
  }
  let text = '';
  try {
    text = readFileSync(PG_LOG).subarray(logPos0).toString('utf8');
  } catch {
    console.log('# журнал Postgres не читается — проверка по логу пропущена');
    return;
  }
  const bad = text.split('\n').filter((l) => /deadlock detected|could not obtain lock|canceling statement due to lock timeout|lock_not_available/i.test(l));
  assert.deepEqual(bad, []);
});
