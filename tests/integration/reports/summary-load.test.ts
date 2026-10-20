// Нагрузка сводки (R1a): синтетика на 5 000 карточек — сводка РОП и директора не дольше 300 мс.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { getSummary } from '../../../src/server/domain/reports';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { MIN, SEED_NOW, SPACE, U, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedPool, viewerOf } from './helpers';

const LIMIT_MS = 300;
let db: TestDb;
const clock = { now: SEED_NOW };

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  const sql = db.sql;
  const t = SEED_NOW - 86_400_000;
  // 3 600 в пуле (часть с задержкой) + 1 200 карточек операторов + 200 из синтетики мира = 5 000
  await seedPool(sql, 3600);
  await sql`UPDATE cards SET hold_reason = 'dup_pair' WHERE id IN (SELECT id FROM cards WHERE id LIKE 'pc-%' ORDER BY id LIMIT 100)`;
  const nums = Array.from({ length: 1200 }, (_, i) => i + 1);
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            SELECT 'ld-' || i, 'company', 'ТОО Нагрузка ' || i, 'нагрузка ' || i, 'нагрузка ' || i, 'import', ${t}::bigint, ${t}::bigint FROM unnest(${nums}::int[]) AS i`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, next_call_at, created_at, updated_at)
            SELECT 'lc-' || i, ${SPACE}::text, 'ld-' || i,
                   (ARRAY[${U.opA}, ${U.opB}, ${U.duty}]::text[])[1 + i % 3],
                   CASE WHEN i % 3 = 0 THEN 'callback' ELSE 'retry' END,
                   ${SEED_NOW - 3 * 60 * MIN}::bigint - i * 1000, ${t}::bigint, ${t}::bigint FROM unnest(${nums}::int[]) AS i`;
  await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, lpr, applied, occurred_at, received_at, config_rev)
            SELECT 'lcall-' || i || '-' || k, ${SPACE}::text, 'lc-' || i, 'ld-' || i, (ARRAY[${U.opA}, ${U.opB}, ${U.duty}]::text[])[1 + i % 3], 'ui', '',
                   CASE WHEN k = 1 THEN 'no_answer' ELSE 'callback' END, CASE WHEN k = 1 THEN 'no_answer' ELSE 'callback' END,
                   CASE WHEN k = 2 AND i % 5 = 0 THEN 'yes' ELSE '' END, 'applied', ${SEED_NOW}::bigint - (i * 7 + k * 60) * 1000, ${SEED_NOW}::bigint, 1
              FROM unnest(${nums}::int[]) AS i, generate_series(1, 3) AS k`;
  await sql`INSERT INTO device_status (user_id, device_id, pending_outbox, seen_at)
            SELECT u, 'd-' || u || '-' || n, n, ${SEED_NOW}::bigint FROM unnest(${[U.opA, U.opB, U.duty]}::text[]) AS u, generate_series(1, 3) AS n`;
  await sql`ANALYZE`;
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

for (const [name, user] of [['РОП', U.rop], ['директор', U.director]] as const) {
  test(`сводка (${name}) на 5 000 карточек: ≤ ${LIMIT_MS} мс`, async () => {
    const viewer = await viewerOf(user);
    await getSummary(viewer); // прогрев: план запросов, кэш настроек
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const s = await getSummary(viewer);
      runs.push(performance.now() - t0);
      assert.equal(s.operators.length, 3);
      assert.ok(s.tiles.overdue.cards >= 400);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2]!;
    console.log(`# сводка (${name}): медиана ${median.toFixed(0)} мс`);
    assert.ok(median <= LIMIT_MS, `медиана ${median.toFixed(0)} мс при пределе ${LIMIT_MS} (${runs.map((r) => r.toFixed(0)).join(', ')})`);
  });
}
