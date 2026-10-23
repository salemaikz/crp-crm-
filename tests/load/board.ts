// Нагрузочный прогон доски оператора (C5, docs/pipeline-v2-design.md §6.2, §7.2): 300 000 синтетических карточек,
// 20 операторов, доска оператора и РОП, «Ещё» до 10-й страницы, поиск, очередь по горячести. Критерий: p95 ответа
// колонки ≤ 300 мс. Запуск (отдельная БД, схема создаётся и удаляется самим прогоном):
//   TEST_DATABASE_URL=postgres://…/crm_pv2_load FEATURE_OP_BOARD=1 FEATURE_CALLBACK_V2=1 \
//     node --import tsx --test tests/load/board.ts
// Прогон идёт дважды: на индексах миграции схемы и на наборе индексов из дизайна §7.2 (создаётся здесь же). Итоги —
// docs/ops/load-pipeline-v2.md. Не входит ни в unit, ни в integration. Только синтетика: номера +7 709 …, компании выдуманные.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import type { Viewer } from '../../src/server/access/types';
import { getQueue } from '../../src/server/domain/calls/queue';
import type { CallsDeps } from '../../src/server/domain/calls';
import { getBoard, getBoardColumn } from '../../src/server/domain/cards/board';
import { loadCallingContext } from '../../src/server/domain/cards/settings';
import type { TestDb } from '../../src/server/platform/db/testing';
import { closeWorld, openWorld } from '../integration/access/world';
import { applySeedConfig } from '../isolation/harness/config';
import { SEED_NOW, SPACE, U } from '../isolation/harness/seed';
import { viewerOf } from '../isolation/harness/actors';

register('../isolation/runner/hooks.mjs', import.meta.url);

const CARDS = Number(process.env['LOAD_CARDS'] ?? 300_000);
const OPERATORS = 20;
const P95_LIMIT_MS = 300;
const ROUNDS = Number(process.env['LOAD_ROUNDS'] ?? 3);
const COLUMNS = ['new', 'callback', 'br', 'bk', 'purchase', 'trash'] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: TestDb;
let ops: Viewer[];
let rop: Viewer;
const lines: string[] = [];
const say = (s: string): void => {
  lines.push(s);
  console.log(s);
};

const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * q) - 1)] ?? 0;
const fmt = (xs: number[]): string => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(0)} p95=${pct(xs, 0.95).toFixed(0)} max=${Math.max(...xs).toFixed(0)} мс`;
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, performance.now() - t0];
}

before(async () => {
  process.env['FEATURE_OP_BOARD'] ??= '1';
  process.env['FEATURE_CALLBACK_V2'] ??= '1';
  db = await openWorld();
  await applySeedConfig();
  const sql = db.sql;
  const t = SEED_NOW - 30 * DAY;
  const ids = Array.from({ length: OPERATORS }, (_, i) => `u-load-${i + 1}`);
  for (const [i, id] of ids.entries()) {
    await sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at) VALUES (${id}, ${`7709700${String(i).padStart(4, '0')}`}, ${`Оператор Нагрузка ${i + 1}`}, FALSE, 'active', ${t})`;
    await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${id}, ${SPACE}, 'operator', NULL, TRUE, ${t}, ${t})`;
  }
  // Клиенты и номера
  await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
            SELECT 'lc-' || i, 'company', 'ТОО Нагрузка ' || i, 'нагрузка ' || i,
                   'тоо нагрузка ' || i || ' 77095' || lpad(i::text, 6, '0'), 'import', ${t}::bigint, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i`;
  await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
            SELECT 'lp-' || i, 'lc-' || i, '77095' || lpad(i::text, 6, '0'), CASE WHEN i % 5 = 0 THEN 'landline' ELSE 'mobile' END, TRUE, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i`;
  // Карточки: 30 % новые, 25 % недозвон, 20 % перезвон, 5 % договорились, 5 % клиенты, 15 % закрытые; 20 операторов поровну.
  // Срок перезвона: 30 % «огонёк» (просрочен или сегодня), остальные — на 1–14 дней вперёд.
  await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, heat, next_call_at, attempts, closed_at, close_reason_code,
                               last_purchase_at, purchases_total, attended_group_at, assigned_at, callback_reason, created_at, updated_at)
            SELECT 'lk-' || i, ${SPACE}::text, 'lc-' || i, (${ids}::text[])[1 + i % ${OPERATORS}::int],
                   st.state,
                   CASE st.state WHEN 'new' THEN 20 WHEN 'callback' THEN 100 + (i % 11) * 50 WHEN 'retry' THEN 0 ELSE 0 END + CASE WHEN st.state IN ('new','callback','retry') AND i % 7 = 0 THEN 200 ELSE 0 END,
                   CASE WHEN st.state IN ('retry','callback') THEN
                          CASE WHEN i % 10 < 3 THEN ${SEED_NOW}::bigint - (i % 72) * ${HOUR}::bigint + (i % 5) * ${HOUR}::bigint
                               ELSE ${SEED_NOW}::bigint + (1 + i % 14) * ${DAY}::bigint + (i % 600) * 60000::bigint END END,
                   CASE WHEN st.state = 'retry' THEN 1 + i % 2 ELSE 0 END,
                   CASE WHEN st.k >= 85 THEN ${SEED_NOW}::bigint - (i % 60) * ${DAY}::bigint END,
                   CASE WHEN st.k >= 85 THEN 'other' ELSE '' END,
                   CASE WHEN st.state = 'client' THEN ${SEED_NOW}::bigint - (i % 200) * ${DAY}::bigint END,
                   CASE WHEN st.state = 'client' THEN 1 ELSE 0 END,
                   CASE WHEN i % 13 = 0 THEN ${SEED_NOW}::bigint - 5 * ${DAY}::bigint END,
                   ${t}::bigint, CASE WHEN st.state = 'callback' THEN (ARRAY['think','no_time','returned','not_now'])[1 + i % 4] ELSE '' END,
                   ${t}::bigint, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i,
                   LATERAL (SELECT i % 100 AS k,
                                   CASE WHEN i % 100 < 30 THEN 'new' WHEN i % 100 < 55 THEN 'retry' WHEN i % 100 < 75 THEN 'callback'
                                        WHEN i % 100 < 80 THEN 'agreed' WHEN i % 100 < 85 THEN 'client'
                                        WHEN i % 100 < 90 THEN 'not_interested' WHEN i % 100 < 95 THEN 'not_target' ELSE 'written_off' END AS state) st`;
  // «Договорились»: открытая сделка и запись (60 % БР группой, 40 % консультация)
  await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
            SELECT 'ld-' || i, ${SPACE}::text, 'sales', 'booked', 'open', 'lc-' || i, 'lk-' || i, (${ids}::text[])[1 + i % ${OPERATORS}::int], ${t}::bigint, ${t}::bigint, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i WHERE i % 100 BETWEEN 75 AND 79`;
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status, created_at, updated_at)
            SELECT 'lb-' || i, ${SPACE}::text, CASE WHEN i % 5 < 3 THEN 'group' ELSE 'individual' END, CASE WHEN i % 5 < 3 THEN 'br' ELSE 'bk' END,
                   CASE WHEN i % 5 < 3 THEN 'ev-today' END, NULL, 'lc-' || i, 'lk-' || i, 'ld-' || i, '2026-11-02', '10:00',
                   ${SEED_NOW}::bigint + (i % 20) * ${DAY}::bigint, 60, 'registered', ${t}::bigint, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i WHERE i % 100 BETWEEN 75 AND 79 AND i % 5 >= 3`;
  // Для БР группой уникально (мероприятие, клиент): отдельные мероприятия не нужны — гости разных клиентов
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at, duration_min, status, created_at, updated_at)
            SELECT 'lb-' || i, ${SPACE}::text, 'group', 'br', 'ev-today', NULL, 'lc-' || i, 'lk-' || i, 'ld-' || i, '2026-11-02', '10:00',
                   ${SEED_NOW}::bigint + (i % 20) * ${DAY}::bigint, 60, 'registered', ${t}::bigint, ${t}::bigint
              FROM generate_series(1, ${CARDS}::int) AS i WHERE i % 100 BETWEEN 75 AND 79 AND i % 5 < 3`;
  await sql`ANALYZE`;
  ops = [];
  for (const id of ids) ops.push(await viewerOf(id));
  rop = await viewerOf(U.rop);
  const [n] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM cards`;
  say(`# Нагрузка доски: карточек ${n?.n}, операторов ${OPERATORS}, раундов ${ROUNDS}`);
});

after(async () => {
  say('');
  if (process.env['LOAD_KEEP']) {
    // Разбор планов: схема остаётся, имя — в выводе; БД целиком удаляет вызвавший
    const [s] = await db.sql<{ s: string }>`SELECT current_schema() AS s`;
    console.log(`LOAD_SCHEMA=${s?.s}`);
    return;
  }
  await closeWorld(db);
});

/** Индексы дизайна §7.2 (набор F2 по умолчанию), создаются прямо в прогоне. */
const PROPOSED = [
  `CREATE INDEX IF NOT EXISTS cards_fire_owner_idx ON cards (space_id, owner_user_id, next_call_at) WHERE state IN ('retry','callback') AND hold_reason = ''`,
  `CREATE INDEX IF NOT EXISTS cards_heat_owner_idx ON cards (space_id, owner_user_id, state, heat DESC, next_call_at, id) WHERE hold_reason = ''`,
  `CREATE INDEX IF NOT EXISTS cards_fire_space_idx ON cards (space_id, next_call_at) WHERE state IN ('retry','callback') AND hold_reason = ''`,
  `CREATE INDEX IF NOT EXISTS cards_heat_space_idx ON cards (space_id, state, heat DESC, next_call_at, id) WHERE hold_reason = ''`,
  `CREATE INDEX IF NOT EXISTS cards_closed_idx ON cards (space_id, closed_at) WHERE state IN ('not_interested','not_target','do_not_call','written_off')`,
  `CREATE INDEX IF NOT EXISTS cards_client_return_idx ON cards (space_id, last_purchase_at) WHERE state = 'client'`,
  `DROP INDEX IF EXISTS bookings_deal_idx`,
  `CREATE INDEX IF NOT EXISTS bookings_deal_idx ON bookings (deal_id, starts_at) WHERE deal_id IS NOT NULL`,
];

async function scenario(label: string, assertLimit: boolean): Promise<void> {
  say(`\n## ${label}`);
  const colTimes = new Map<string, number[]>(COLUMNS.map((c) => [c, []]));
  const boardTimes: number[] = [];
  // Доска оператора: полная доска и каждая колонка по отдельности (ответ колонки — первая страница)
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of ops) {
      boardTimes.push((await timed(() => getBoard(v, {})))[1]);
      for (const c of COLUMNS) colTimes.get(c)!.push((await timed(() => getBoardColumn(v, { column: c })))[1]);
    }
  }
  say(`Доска оператора целиком (6 колонок параллельно): ${fmt(boardTimes)}`);
  for (const c of COLUMNS) say(`  колонка «${c}» оператора, первая страница: ${fmt(colTimes.get(c)!)}`);
  const opCol = COLUMNS.flatMap((c) => colTimes.get(c)!);

  // 20 операторов одновременно открывают доску
  const par: number[] = [];
  for (let r = 0; r < ROUNDS; r++) par.push(...(await Promise.all(ops.map((v) => timed(() => getBoard(v, {}))))).map((x) => x[1]));
  say(`Доска целиком, 20 операторов открывают одновременно: ${fmt(par)} (упирается в процессор: 20 × 12 запросов на 4 ядра)`);
  const parCol: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const c of ['new', 'callback'] as const) parCol.push(...(await Promise.all(ops.map((v) => timed(() => getBoardColumn(v, { column: c }))))).map((x) => x[1]));
  }
  say(`Колонка «new»/«callback», 20 операторов одновременно: ${fmt(parCol)}`);

  // «Ещё» до 10-й страницы
  const more = new Map<string, number[]>();
  for (const who of [...ops.slice(0, 5), rop]) {
    const isRop = who === rop;
    for (const c of ['new', 'callback', 'trash'] as const) {
      let cursor = (await getBoardColumn(who, { column: c })).next;
      for (let page = 2; page <= 10 && cursor; page++) {
        const [res, ms] = await timed(() => getBoardColumn(who, { column: c, cursor }));
        const k = `${isRop ? 'РОП' : 'оператор'} «${c}»`;
        more.set(k, [...(more.get(k) ?? []), ms]);
        cursor = res.next;
      }
    }
  }
  for (const [k, xs] of more) say(`«Ещё» страницы 2–10, ${k}: ${fmt(xs)}`);
  const moreAll = [...more.values()].flat();

  // РОП: доска пространства, колонки, фильтр владельца
  const ropCols = new Map<string, number[]>(COLUMNS.map((c) => [c, []]));
  const ropBoard: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    ropBoard.push((await timed(() => getBoard(rop, {})))[1]);
    for (const c of COLUMNS) ropCols.get(c)!.push((await timed(() => getBoardColumn(rop, { column: c })))[1]);
  }
  say(`Доска РОП (всё пространство): ${fmt(ropBoard)}`);
  for (const c of COLUMNS) say(`  колонка «${c}» РОП, первая страница: ${fmt(ropCols.get(c)!)}`);
  const ropOwner: number[] = [];
  for (const o of ops.slice(0, 5)) for (const c of COLUMNS) ropOwner.push((await timed(() => getBoardColumn(rop, { column: c, owner: o.userId })))[1]);
  say(`РОП с фильтром по владельцу, все колонки: ${fmt(ropOwner)}`);
  const ropFilters: number[] = [];
  for (const f of [['today'], ['attendedGroup'], ['noShow'], ['purchased']]) for (const c of ['new', 'callback'] as const) ropFilters.push((await timed(() => getBoardColumn(rop, { column: c, filter: f })))[1]);
  say(`РОП с фильтрами признаков (today, attendedGroup, noShow, purchased), «new» и «callback»: ${fmt(ropFilters)}`);

  // Поиск
  const search: number[] = [];
  for (const q of ['Нагрузка 1234', 'нагрузка 5', '770950012345', 'Нагрузка 29999']) {
    for (const v of [ops[0]!, rop]) search.push((await timed(() => getBoard(v, { q })))[1]);
  }
  say(`Поиск (название, номер) на доске, оператор и РОП: ${fmt(search)}`);

  // Очередь «Звонить подряд» по горячести и по группам
  const deps = { context: loadCallingContext, now: () => SEED_NOW } as unknown as CallsDeps;
  const queue: number[] = [];
  for (let r = 0; r < ROUNDS; r++) for (const v of ops) queue.push((await timed(() => getQueue(deps, v, { limit: 6, exclude: [], group: 'all' })))[1]);
  say(`Очередь «Звонить подряд» (queue.sort=heat), лимит 6: ${fmt(queue)}`);

  const colAll = [...opCol, ...COLUMNS.flatMap((c) => ropCols.get(c)!), ...moreAll, ...parCol];
  say(`ИТОГО ответ колонки (оператор, РОП, «Ещё»): ${fmt(colAll)}; критерий p95 ≤ ${P95_LIMIT_MS} мс`);
  if (assertLimit) {
    assert.ok(pct(colAll, 0.95) <= P95_LIMIT_MS, `p95 колонки ${pct(colAll, 0.95).toFixed(0)} мс > ${P95_LIMIT_MS}`);
    // Худший случай в отдельности: каждая страница «Ещё» РОП (охват пространства) тоже укладывается
    for (const [k, xs] of more) assert.ok(Math.max(...xs) <= P95_LIMIT_MS, `«Ещё» ${k}: максимум ${Math.max(...xs).toFixed(0)} мс > ${P95_LIMIT_MS}`);
  }
}

test('на индексах схемы (до миграции F2)', async () => {
  await scenario('Индексы миграции схемы v1 (без индексов F2)', false);
});

test('на индексах §7.2 дизайна', async () => {
  for (const stmt of PROPOSED) await db.exec(stmt);
  await db.sql`ANALYZE`;
  await db.sql`SELECT pg_stat_reset()`;
  await scenario('Индексы схемы v1 + набор §7.2 дизайна', true);
  await new Promise((r) => setTimeout(r, 1500)); // статистика Postgres сбрасывается с задержкой
  const used = await db.sql<{ rel: string; idx: string; n: number }>`
    SELECT relname AS rel, indexrelname AS idx, idx_scan::int AS n FROM pg_stat_user_indexes
     WHERE schemaname = current_schema() AND relname IN ('cards','bookings','deals','client_phones','clients') ORDER BY relname, idx_scan DESC`;
  say('\nИспользование индексов за прогон (idx_scan):');
  for (const u of used) say(`  ${u.rel}.${u.idx}: ${u.n}`);
});

test('повторно без индексов F2 (оценка разброса между прогонами)', async () => {
  for (const idx of ['cards_fire_owner_idx', 'cards_heat_owner_idx', 'cards_fire_space_idx', 'cards_heat_space_idx', 'cards_closed_idx', 'cards_client_return_idx']) await db.exec(`DROP INDEX IF EXISTS ${idx}`);
  await db.exec('DROP INDEX IF EXISTS bookings_deal_idx');
  await db.exec('CREATE INDEX IF NOT EXISTS bookings_deal_idx ON bookings (deal_id) WHERE deal_id IS NOT NULL');
  await db.sql`ANALYZE`;
  await scenario('Повтор: индексы схемы v1 (F2 снят)', false);
});

test('размер таблицы', async () => {
  const [row] = await db.sql<{ n: number }>`SELECT pg_total_relation_size('cards')::bigint / 1048576 AS n`;
  say(`\nРазмер cards с индексами: ${row?.n} МБ`);
  assert.ok(true);
});
