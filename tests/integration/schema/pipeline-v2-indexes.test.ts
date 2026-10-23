// Индексы доски и очереди (F2, docs/pipeline-v2-design.md §6.2, §7.2; D-350) на Postgres 16: миграция с нуля и на
// базе прежней версии, повторный прогон ничего не меняет, sha256 записан, набор ровно из четырёх индексов (лишних из
// набора дизайна нет). На 300 000 карточках колонка «Перезвон» оператора и РОП и «Мусор» РОП читаются по индексам
// миграции, без Seq Scan по cards. План снимается с настоящего SQL репозитория доски (EXPLAIN ANALYZE того же текста).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { calling } from '@crm/core';
import { migrate, migrationStatus, sha256Hex } from '../../../src/server/platform/db/migrate';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import type { Sql } from '../../../src/server/platform/db';
import type { Viewer } from '../../../src/server/access/types';
import { BOARD_PAGE } from '../../../src/server/domain/cards/board';
import { selectColumnKeys, type ColumnSelect, type KeyCursor } from '../../../src/server/domain/cards/boardRepo';
import { viewerOf } from '../../isolation/harness/actors';
import { U } from '../../isolation/harness/seed';
import { DAY, HOUR, SEED_NOW, SPACE, boundsNow, closeBoardWorld, openBoardWorld } from '../cards/boardWorld';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const FILE = '2026-10-30-platform-pipeline-v2-indexes.sql';
const SQL = readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

const FIRE = "WHERE ((state = ANY (ARRAY['retry'::text, 'callback'::text])) AND (hold_reason = ''::text))";
/** Ожидаемые определения (pg_get_indexdef без имени схемы). */
const EXPECTED: Record<string, string> = {
  cards_fire_owner_idx: `CREATE INDEX cards_fire_owner_idx ON cards USING btree (space_id, owner_user_id, next_call_at) ${FIRE}`,
  cards_cb_owner_idx: `CREATE INDEX cards_cb_owner_idx ON cards USING btree (space_id, owner_user_id, heat DESC, next_call_at, id) ${FIRE}`,
  cards_cb_space_idx: `CREATE INDEX cards_cb_space_idx ON cards USING btree (space_id, heat DESC, next_call_at, id) ${FIRE}`,
  cards_closed_idx:
    "CREATE INDEX cards_closed_idx ON cards USING btree (space_id, closed_at) WHERE (state = ANY (ARRAY['not_interested'::text, 'not_target'::text, 'do_not_call'::text, 'written_off'::text]))",
};

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Каталог миграций по эту включительно (`through`) или без неё (прежняя версия): более поздние файлы не берутся, иначе
 * N−1 получил бы миграцию, которая опирается на эту.
 */
async function migrationsUpTo(through: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crm-migrations-n1-'));
  dirs.push(dir);
  for (const f of await readdir(MIGRATIONS)) {
    if (f.endsWith('.sql') && (f < FILE || (through && f === FILE))) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
  }
  return dir;
}

/** Индексы cards и bookings: имя → определение без имени схемы. */
async function indexes(db: TestDb): Promise<Record<string, string>> {
  const rows = await db.sql<{ name: string; def: string; schema: string }>`
    SELECT i.indexname AS name, i.indexdef AS def, i.schemaname AS schema FROM pg_indexes i
     WHERE i.schemaname = current_schema() AND i.tablename IN ('cards','bookings') ORDER BY i.indexname`;
  return Object.fromEntries(rows.map((r) => [r.name, r.def.replace(` ON ${r.schema}.`, ' ON ')]));
}

test('с нуля дважды: те же индексы, второй прогон ничего не применяет, sha256 записан; повтор файла без журнала — без ошибок', async () => {
  const defs: Record<string, string>[] = [];
  for (let run = 0; run < 2; run++) {
    const db = await createTestDb({ migrate: false, register: false });
    try {
      const applied = await migrate(db, MIGRATIONS);
      assert.ok(applied.includes(FILE), 'миграция применена с нуля');
      assert.deepEqual(await migrate(db, MIGRATIONS), [], 'второй прогон ничего не применяет');
      const st = await migrationStatus(db, MIGRATIONS);
      assert.deepEqual([st.pending, st.changed, st.unknown], [[], [], []]);
      const [row] = await db.sql<{ sha256: string }>`SELECT sha256 FROM schema_migrations WHERE name = ${FILE}`;
      assert.equal(row?.sha256, sha256Hex(SQL));
      // IF NOT EXISTS: тот же файл поверх применённого не падает и ничего не меняет
      const before = await indexes(db);
      await db.exec(SQL);
      assert.deepEqual(await indexes(db), before);
      defs.push(before);
    } finally {
      await db.close();
    }
  }
  assert.deepEqual(defs[0], defs[1], 'две установки с нуля дают одинаковый набор индексов');
  for (const [name, def] of Object.entries(EXPECTED)) assert.equal(defs[0]![name], def, name);
});

test('на базе прежней версии: добавляет ровно четыре индекса, неиспользуемых из набора дизайна нет', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, await migrationsUpTo(false));
    const prev = await indexes(db);
    const cur = await migrationsUpTo(true);
    assert.deepEqual((await migrationStatus(db, cur)).pending, [FILE]);
    assert.deepEqual(await migrate(db, cur), [FILE]);
    assert.deepEqual(await migrate(db, cur), []);
    const next = await indexes(db);
    const added = Object.keys(next).filter((n) => !(n in prev)).sort();
    assert.deepEqual(added, Object.keys(EXPECTED).sort());
    for (const n of Object.keys(prev)) assert.equal(next[n], prev[n], `индекс ${n} прежней версии не изменён`);
    // Прогон C5: с state в ключе порядок heat не получается, срок пространства и возврат клиента вклада не дали
    for (const n of ['cards_heat_owner_idx', 'cards_heat_space_idx', 'cards_fire_space_idx', 'cards_client_return_idx']) assert.ok(!(n in next), `${n} не создаётся`);
  } finally {
    await db.close();
  }
});

// ---------- Планы на 300 000 карточках ----------

const CARDS = 300_000;
const OPERATORS = 20;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function walk(n: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
}

/** Sql, который вместо выполнения снимает EXPLAIN (ANALYZE) того же текста с теми же параметрами и возвращает пусто. */
function explaining(sql: Sql, plans: PlanNode[][]): Sql {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const s = [...strings];
    s[0] = `EXPLAIN (ANALYZE, FORMAT JSON) ${s[0]}`;
    const rows = await sql<Record<string, unknown>>(Object.assign(s, { raw: [...s] }) as unknown as TemplateStringsArray, ...values);
    const raw = Object.values(rows[0] ?? {})[0];
    const doc = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
    plans.push(walk(doc[0]!.Plan));
    return [];
  }) as Sql;
}

describe('300 000 карточек: колонки доски по индексам миграции', () => {
  let db: TestDb;
  let op: Viewer;
  let rop: Viewer;
  let bounds: calling.DueBounds;

  before(async () => {
    db = await openBoardWorld();
    const sql = db.sql;
    const t = SEED_NOW - 30 * DAY;
    const ids = Array.from({ length: OPERATORS }, (_, i) => `u-idx-${i + 1}`);
    for (const [i, id] of ids.entries()) {
      await sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at) VALUES (${id}, ${`7709710${String(i).padStart(4, '0')}`}, ${`Оператор Индекс ${i + 1}`}, FALSE, 'active', ${t})`;
      await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at) VALUES (${id}, ${SPACE}, 'operator', NULL, TRUE, ${t}, ${t})`;
    }
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              SELECT 'ic-' || i, 'company', 'ТОО Индекс ' || i, 'индекс ' || i, 'тоо индекс ' || i, 'import', ${t}::bigint, ${t}::bigint
                FROM generate_series(1, ${CARDS}::int) AS i`;
    // Распределение прогона C5: 30 % новые, 25 % недозвон, 20 % перезвон, 5 % договорились, 5 % клиенты, 15 % закрытые;
    // у перезвона и недозвона 30 % — огонёк (срок до конца сегодняшних суток), остальные — 1–14 дней вперёд. Владелец —
    // по блокам из 100 подряд, огонёк — по i / 7: у каждого оператора все состояния и обе части колонки «Перезвон»
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, heat, next_call_at, attempts, closed_at, close_reason_code,
                                 last_purchase_at, purchases_total, assigned_at, created_at, updated_at)
              SELECT 'ik-' || i, ${SPACE}::text, 'ic-' || i, (${ids}::text[])[1 + (i / 100) % ${OPERATORS}::int], st.state,
                     CASE st.state WHEN 'new' THEN 20 WHEN 'callback' THEN 100 + (i % 11) * 50 ELSE 0 END
                       + CASE WHEN st.state IN ('new','callback','retry') AND i % 7 = 0 THEN 200 ELSE 0 END,
                     CASE WHEN st.state IN ('retry','callback') THEN
                            CASE WHEN (i / 7) % 10 < 3 THEN ${SEED_NOW}::bigint - (i % 72) * ${HOUR}::bigint
                                 ELSE ${SEED_NOW}::bigint + (1 + i % 14) * ${DAY}::bigint + (i % 600) * 60000::bigint END END,
                     CASE WHEN st.state = 'retry' THEN 1 + i % 2 ELSE 0 END,
                     CASE WHEN st.k >= 85 THEN ${SEED_NOW}::bigint - (i % 60) * ${DAY}::bigint END,
                     CASE WHEN st.k >= 85 THEN 'other' ELSE '' END,
                     CASE WHEN st.state = 'client' THEN ${SEED_NOW}::bigint - (i % 200) * ${DAY}::bigint END,
                     CASE WHEN st.state = 'client' THEN 1 ELSE 0 END,
                     ${t}::bigint, ${t}::bigint, ${t}::bigint
                FROM generate_series(1, ${CARDS}::int) AS i,
                     LATERAL (SELECT i % 100 AS k,
                                     CASE WHEN i % 100 < 30 THEN 'new' WHEN i % 100 < 55 THEN 'retry' WHEN i % 100 < 75 THEN 'callback'
                                          WHEN i % 100 < 80 THEN 'agreed' WHEN i % 100 < 85 THEN 'client'
                                          WHEN i % 100 < 90 THEN 'not_interested' WHEN i % 100 < 95 THEN 'not_target' ELSE 'written_off' END AS state) st`;
    await sql`ANALYZE`;
    op = await viewerOf(ids[0]!);
    rop = await viewerOf(U.rop);
    bounds = await boundsNow();
  });
  after(() => closeBoardWorld(db));

  /** Запрос страницы колонки, как его собирает `board.ts`: `wide` — охват пространства (РОП, директор). */
  const select = (kind: 'callback' | 'closed', cursor: KeyCursor | null, wide: boolean): ColumnSelect => ({
    spaceId: SPACE,
    kind,
    states: kind === 'callback' ? ['retry', 'callback'] : ['not_interested', 'not_target', 'do_not_call', 'written_off'],
    agreed: { types: [], allTypes: [], fallback: false },
    closedFrom: kind === 'closed' ? SEED_NOW - 30 * DAY : null,
    bounds,
    mobileFirst: !wide,
    wide,
    cursor,
    limit: BOARD_PAGE + 1,
    filters: { owner: null, today: false, attendedGroup: false, attendedIndividual: false, noShow: false, purchased: false, callbackReason: null },
  });

  /** План страницы колонки: узлы дерева EXPLAIN настоящего запроса репозитория. */
  async function plan(v: Viewer, q: ColumnSelect): Promise<PlanNode[]> {
    const plans: PlanNode[][] = [];
    await selectColumnKeys(explaining(db.sql, plans), v, q);
    assert.equal(plans.length, 1);
    return plans[0]!;
  }

  const seqOnCards = (nodes: PlanNode[]) => nodes.filter((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'cards');
  const used = (nodes: PlanNode[]) => new Set(nodes.flatMap((n) => (n['Index Name'] ? [n['Index Name']] : [])));

  // Курсор «Ещё» во второй части колонки (не огонёк): ключ середины, чтобы страница не была пустой
  const deep: KeyCursor = { part: 1, k1: 300, k2: SEED_NOW + 5 * DAY, k3: 0, id: 'ik-0' };

    // Свои и временные (`owner = я OR acting = я`) упорядоченный индекс владельца взять не могут. С LIMIT планировщик
  // выбрал бы обход индекса пространства по горячести с фильтром, а у оператора без огонька это проход всего индекса
  // (прогон: колонка оператора 25 → 92 мс p95). Поэтому узкий охват читает часть целиком по индексам владельца.
  test('«Перезвон» оператора (свои и временные): по индексам владельца, не по индексу пространства, без Seq Scan', async () => {
    for (const cursor of [null, deep]) {
      const nodes = await plan(op, select('callback', cursor, false));
      assert.deepEqual(seqOnCards(nodes), [], `Seq Scan по cards (курсор ${cursor ? 'есть' : 'нет'})`);
      const u = used(nodes);
      assert.ok(!u.has('cards_cb_space_idx'), `узкий охват не обходит индекс пространства: ${[...u].join(', ')}`);
      if (!cursor) assert.ok(u.has('cards_fire_owner_idx'), `огонёк по диапазону срока владельца, а не ${[...u].join(', ')}`);
    }
  });

  test('«Перезвон» оператора без огонька: часть «огонёк» не проходит индекс пространства', async () => {
    await db.sql`UPDATE cards SET next_call_at = next_call_at + ${3 * DAY}::bigint
                  WHERE owner_user_id = ${op.userId} AND state IN ('retry','callback') AND next_call_at < ${bounds.tomorrowStart}::bigint`;
    await db.sql`ANALYZE cards`;
    const nodes = await plan(op, select('callback', null, false));
    assert.deepEqual(seqOnCards(nodes), []);
    assert.ok(!used(nodes).has('cards_cb_space_idx'), `${[...used(nodes)].join(', ')}`);
  });

  test('«Перезвон» РОП с фильтром по оператору: индекс владельца по горячести, без Seq Scan', async () => {
    for (const cursor of [null, deep]) {
      const q = select('callback', cursor, true);
      const nodes = await plan(rop, { ...q, filters: { ...q.filters, owner: op.userId } });
      assert.deepEqual(seqOnCards(nodes), [], `Seq Scan по cards (курсор ${cursor ? 'есть' : 'нет'})`);
      const u = used(nodes);
      assert.ok(u.has('cards_cb_owner_idx'), `по cards_cb_owner_idx, а не ${[...u].join(', ')}`);
    }
  });

  test('«Перезвон» РОП (всё пространство): индекс пространства по горячести, без Seq Scan', async () => {
    for (const cursor of [null, deep]) {
      const nodes = await plan(rop, select('callback', cursor, true));
      assert.deepEqual(seqOnCards(nodes), [], `Seq Scan по cards (курсор ${cursor ? 'есть' : 'нет'})`);
      const u = used(nodes);
      assert.ok(u.has('cards_cb_space_idx'), `по cards_cb_space_idx, а не ${[...u].join(', ')}`);
    }
  });

  test('«Мусор» РОП за окно дней: индекс закрытых, без Seq Scan', async () => {
    const nodes = await plan(rop, select('closed', null, true));
    assert.deepEqual(seqOnCards(nodes), [], 'Seq Scan по cards');
    assert.ok(used(nodes).has('cards_closed_idx'), `по cards_closed_idx, а не ${[...used(nodes)].join(', ')}`);
  });
});
