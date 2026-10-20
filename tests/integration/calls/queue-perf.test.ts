// Замер очереди (docs/calls-design.md §8): 5 000 карточек (10 сотрудников × 500), 30 запросов, p95 ≤ 300 мс.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getQueue } from '../../../src/server/domain/calls/queue';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { HOUR, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  const owners = [U.opA, U.opB, U.rop, U.consultant, U.duty, U.mktHead, U.marketer, U.director, U.admin, U.disabled];
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
               SELECT 'cl-perf-' || i, 'company', 'ТОО Нагрузка ' || i, 'нагрузка ' || i, 'нагрузка ' || i, 'import', ${SEED_NOW}::bigint, ${SEED_NOW}::bigint
                 FROM generate_series(1, 5000) AS i`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
               SELECT 'ph-perf-' || i, 'cl-perf-' || i, '77092' || lpad(i::text, 6, '0'), CASE WHEN i % 3 = 0 THEN 'landline' ELSE 'mobile' END, TRUE, ${SEED_NOW}::bigint
                 FROM generate_series(1, 5000) AS i`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, assigned_at, created_at, updated_at)
               SELECT 'cd-perf-' || i, 'sp-sales', 'cl-perf-' || i, (${owners}::text[])[1 + (i % 10)],
                      (ARRAY['new','retry','callback'])[1 + (i % 3)], CASE WHEN i % 3 = 0 THEN NULL ELSE ${SEED_NOW}::bigint - (i % 50) * ${HOUR}::bigint END,
                      ${SEED_NOW}::bigint - i * 1000, ${SEED_NOW}::bigint, ${SEED_NOW}::bigint
                 FROM generate_series(1, 5000) AS i`;
  await db.sql`ANALYZE cards`;
  await db.sql`ANALYZE client_phones`;
});
after(() => closeCallsWorld(db));

test('очередь оператора: 30 запросов, p95 не больше 300 мс', async () => {
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = await getQueue(deps, opA, { limit: 4, exclude: [], group: 'all' });
    times.push(performance.now() - t0);
    assert.equal(r.items.length, 4);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
  console.log(`# очередь: p50 ${times[15]!.toFixed(1)} мс, p95 ${p95.toFixed(1)} мс`);
  assert.ok(p95 <= 300, `p95 ${p95.toFixed(1)} мс > 300`);
});
