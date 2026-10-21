// Нагрузка отчётов за период (R3a): синтетика на 5 000 карточек и 48 000 звонков за 92 дня —
// каждый отчёт РОП не дольше 300 мс (дизайн §1.4: иначе architect даёт индексы).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { calling } from '@crm/core';
import { getReport } from '../../../src/server/domain/reports';
import { ISSUE_KINDS } from '../../../src/server/domain/reports/definitions';
import { funnelBySource } from '../../../src/server/domain/reports/periodRepo';
import { legacyFunnelBySource } from './legacyFunnelBySource';
import type { ReportQuery } from '../../../src/server/domain/reports/reportTypes';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { DAY, SEED_NOW, SPACE, U, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedPool, viewerOf } from './helpers';

const LIMIT_MS = 300;
const PERIOD = { from: '2026-07-29', to: '2026-10-28' }; // 92 дня
let db: TestDb;
const clock = { now: SEED_NOW };
const NO_FILTERS = { userIds: null, sourceKey: null };

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  const sql = db.sql;
  const t = SEED_NOW - DAY;
  const users = [U.opA, U.opB, U.duty];
  // 3 600 в пуле + 1 200 карточек операторов + 200 из мира = 5 000
  await seedPool(sql, 3600);
  const cards = Array.from({ length: 1200 }, (_, i) => i + 1);
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            SELECT 'ld-' || i, 'company', 'ТОО Нагрузка ' || i, 'нагрузка ' || i, 'нагрузка ' || i, 'import', ${t}::bigint, ${t}::bigint FROM unnest(${cards}::int[]) AS i`;
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, created_at, updated_at)
            SELECT 'lc-' || i, ${SPACE}::text, 'ld-' || i, (${users}::text[])[1 + i % 3], 'retry', ${t}::bigint, ${t}::bigint FROM unnest(${cards}::int[]) AS i`;
  await sql`INSERT INTO client_sources (id, client_id, source_kind, source_key, first_seen_at)
            SELECT 'ls-' || i, 'ld-' || i, 'ingest', CASE WHEN i % 3 = 0 THEN 'new_base' WHEN i % 3 = 1 THEN 'whatsapp_in' ELSE '' END, ${t}::bigint FROM unnest(${cards}::int[]) AS i`;
  // 48 000 звонков, равномерно по 91 дню
  await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, reason_code, lpr, applied, occurred_at, received_at, config_rev)
            SELECT 'lcall-' || i || '-' || k, ${SPACE}::text, 'lc-' || i, 'ld-' || i, (${users}::text[])[1 + (i + k) % 3], 'ui', '',
                   (ARRAY['no_answer','callback','agreed','not_interested','not_target'])[1 + (i + k) % 5],
                   (ARRAY['no_answer','callback','agreed','not_interested','not_target'])[1 + (i + k) % 5],
                   CASE WHEN (i + k) % 5 >= 3 THEN 'busy' ELSE '' END, CASE WHEN (i + k) % 7 = 0 THEN 'yes' ELSE '' END, 'applied',
                   ${SEED_NOW}::bigint - ((i * 7919 + k * 104729) % (91 * 86400))::bigint * 1000, ${SEED_NOW}::bigint, 1
              FROM unnest(${cards}::int[]) AS i, generate_series(1, 40) AS k`;
  await sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
            SELECT 'lal-' || n, ${SPACE}::text, 'lc-' || (1 + n % 1200), NULL, (${users}::text[])[1 + n % 3], 'auto', TRUE, 'load',
                   to_char(date '2026-10-28' - (n % 91), 'YYYY-MM-DD'), NULL, ${SEED_NOW}::bigint
              FROM generate_series(1, 5000) AS n`;
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, lost_at,
                               lost_reason_code, stage_changed_at, created_by, created_at, updated_at)
            SELECT 'dl-l-' || i, ${SPACE}::text, 'sales', CASE WHEN i % 2 = 0 THEN 'won' ELSE 'lost' END, CASE WHEN i % 2 = 0 THEN 'won' ELSE 'lost' END,
                   'ld-' || i, 'lc-' || i, (${users}::text[])[1 + i % 3], (ARRAY['consult','master','smm'])[1 + i % 3], 50000 + i,
                   CASE WHEN i % 2 = 0 THEN ${SEED_NOW}::bigint - ((i * 6007) % (91 * 86400))::bigint * 1000 END,
                   CASE WHEN i % 2 = 1 THEN ${SEED_NOW}::bigint - ((i * 6007) % (91 * 86400))::bigint * 1000 END,
                   CASE WHEN i % 2 = 1 THEN 'price' ELSE '' END, ${t}::bigint, ${U.rop}, ${t}::bigint, ${t}::bigint
              FROM unnest(${cards}::int[]) AS i`;
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min,
                                  status, booked_by_user_id, responsible_user_id, created_at, updated_at)
            SELECT 'lbk-' || i, ${SPACE}::text, 'individual', 'consult', 'rs-cons', 'ld-' || i, 'lc-' || i, CASE WHEN i % 2 = 0 THEN 'dl-l-' || i END,
                   to_char(date '2026-10-28' - ((i * 13) % 91), 'YYYY-MM-DD'), '11:00', ${SEED_NOW}::bigint - ((i * 13) % 91)::bigint * 86400000, 60,
                   (ARRAY['attended','no_show','confirmed','cancelled'])[1 + i % 4], (${users}::text[])[1 + i % 3], (${users}::text[])[1 + i % 3],
                   ${SEED_NOW}::bigint - ((i * 13) % 91)::bigint * 86400000 - 3600000, ${SEED_NOW}::bigint
              FROM unnest(${cards}::int[]) AS i`;
  await sql`ANALYZE`;
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

const QUERIES: [string, ReportQuery][] = [
  ['операторы (по дням)', { key: 'operators', period: PERIOD, filters: NO_FILTERS, grouping: 'day' }],
  ['операторы (источник)', { key: 'operators', period: PERIOD, filters: { userIds: null, sourceKey: 'new_base' }, grouping: 'total' }],
  ['воронка (операторы)', { key: 'funnel', period: PERIOD, filters: NO_FILTERS, by: 'operator' }],
  ['воронка (источники)', { key: 'funnel', period: PERIOD, filters: NO_FILTERS, by: 'source' }],
  ['выручка', { key: 'revenue', period: PERIOD, filters: NO_FILTERS }],
  ['явка', { key: 'attendance', period: PERIOD, filters: NO_FILTERS, by: 'consultant' }],
  ['причины', { key: 'reasons', period: PERIOD, filters: NO_FILTERS }],
];

for (const [name, q] of QUERIES) {
  test(`отчёт «${name}» за 92 дня на 5 000 карточек: ≤ ${LIMIT_MS} мс`, async () => {
    const viewer = await viewerOf(U.rop);
    await getReport(viewer, q); // прогрев: план запросов, кэш настроек
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await getReport(viewer, q);
      runs.push(performance.now() - t0);
    }
    runs.sort((a, b) => a - b);
    const median = runs[2]!;
    console.log(`# отчёт «${name}»: медиана ${median.toFixed(0)} мс`);
    assert.ok(median <= LIMIT_MS, `медиана ${median.toFixed(0)} мс при пределе ${LIMIT_MS} (${runs.map((r) => r.toFixed(0)).join(', ')})`);
  });
}

test('на нагрузке отчёты не пустые и согласованы с данными', async () => {
  const viewer = await viewerOf(U.rop);
  const ops = await getReport(viewer, { key: 'operators', period: PERIOD, filters: NO_FILTERS, grouping: 'total' });
  assert.equal(ops.totals.outcomes, 48_000 + 2); // все звонки периода: 48 000 синтетических и по одному вчерашнему у A и B из мира
});

test('воронка по источникам: CTE «первый источник» даёт то же, что прежний подзапрос на строку', async () => {
  const viewer = await viewerOf(U.rop);
  const args = {
    spaceId: SPACE,
    from: PERIOD.from,
    to: PERIOD.to,
    fromMs: Date.parse('2026-07-29T00:00:00+05:00'),
    toMs: Date.parse('2026-10-29T00:00:00+05:00'),
    timeZone: 'Asia/Almaty',
    sourceKey: null,
    connectedKinds: calling.CONNECTED_KINDS,
    issueKinds: ISSUE_KINDS,
  };
  const key = (r: { src: string; step: string; n: number }) => `${r.step}|${r.src}|${r.n}`;
  for (const userIds of [null, [U.opA, U.opB]]) {
    const fresh = (await funnelBySource(viewer, db.sql, { ...args, userIds })).map(key).sort();
    const legacy = (await legacyFunnelBySource(viewer, db.sql, { ...args, userIds })).map(key).sort();
    assert.ok(fresh.length > 6, 'в выборке должны быть все шаги и несколько источников');
    assert.deepEqual(fresh, legacy);
  }
});

test('операторы с фильтром по источнику: число итогов совпадает с прямым подсчётом по первому источнику клиента', async () => {
  const viewer = await viewerOf(U.rop);
  const rep = await getReport(viewer, { key: 'operators', period: PERIOD, filters: { userIds: null, sourceKey: 'new_base' }, grouping: 'total' });
  const [row] = await db.sql<{ n: number }>`
    SELECT count(*)::int AS n FROM calls ca
     WHERE ca.space_id = ${SPACE} AND ca.user_id IS NOT NULL AND ca.via <> 'import'
       AND ca.occurred_at >= ${Date.parse('2026-07-29T00:00:00+05:00')}::bigint AND ca.occurred_at < ${Date.parse('2026-10-29T00:00:00+05:00')}::bigint
       AND (SELECT CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END FROM client_sources s
             WHERE s.client_id = ca.client_id ORDER BY s.first_seen_at, s.id LIMIT 1) = 'new_base'`;
  assert.ok(row && row.n > 1000);
  assert.equal(rep.totals.outcomes, row.n);
});
