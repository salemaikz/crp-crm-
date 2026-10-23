// Миграция воронки v2 (docs/pipeline-v2-design.md §7.1, D-336…D-339) на Postgres 16: накатывается на базу
// прежней версии (N−1) и с нуля, повторный прогон ничего не меняет, sha256 записан; прежние вставки работают
// без новых колонок (N−1 стартует), канал «board» принят, неизвестный канал и значения вне CHECK — нет.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, migrationStatus, sha256Hex } from '../../../src/server/platform/db/migrate';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { closeWorld, openWorld } from '../access/world';
import { SEED_NOW, SPACE, U } from '../../isolation/harness/seed';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const FILE = '2026-10-27-platform-pipeline-v2.sql';
const SQL = readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

const NEW_COLUMNS: Record<string, Record<string, { type: string; nullable: boolean; def: string | null }>> = {
  cards: {
    callback_reason: { type: 'text', nullable: false, def: "''::text" },
    callback_touches: { type: 'integer', nullable: false, def: '0' },
    next_call_precision: { type: 'text', nullable: false, def: "'time'::text" },
    attended_group_at: { type: 'bigint', nullable: true, def: null },
    attended_individual_at: { type: 'bigint', nullable: true, def: null },
    last_no_show_at: { type: 'bigint', nullable: true, def: null },
    last_no_show_kind: { type: 'text', nullable: false, def: "''::text" },
    purchases_total: { type: 'integer', nullable: false, def: '0' },
    last_purchase_at: { type: 'bigint', nullable: true, def: null },
    heat: { type: 'integer', nullable: false, def: '0' },
  },
  calls: { callback_precision: { type: 'text', nullable: false, def: "'time'::text" } },
  tasks: { due_precision: { type: 'text', nullable: false, def: "'time'::text" } },
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

async function columns(db: TestDb) {
  // postgres.js отдаёт строки в camelCase
  return db.sql<{ tableName: string; columnName: string; dataType: string; isNullable: string; columnDefault: string | null }>`
    SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('cards','calls','tasks') ORDER BY table_name, ordinal_position`;
}

async function constraints(db: TestDb) {
  return db.sql<{ conname: string; def: string }>`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relnamespace = current_schema()::regnamespace AND t.relname IN ('cards','calls','tasks') ORDER BY c.conname`;
}

test('на базе прежней версии: применяется только эта миграция, второй прогон — ничего, sha256 записан', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, await migrationsUpTo(false));
    const before = await columns(db);
    assert.ok(!before.some((c) => c.columnName === 'heat'), 'в N−1 колонки heat нет');
    const cur = await migrationsUpTo(true);
    assert.deepEqual((await migrationStatus(db, cur)).pending, [FILE]);
    assert.deepEqual(await migrate(db, cur), [FILE]);
    assert.deepEqual(await migrate(db, cur), []);
    const st = await migrationStatus(db, cur);
    assert.deepEqual([st.pending, st.changed, st.unknown], [[], [], []]);
    const [row] = await db.sql<{ sha256: string }>`SELECT sha256 FROM schema_migrations WHERE name = ${FILE}`;
    assert.equal(row?.sha256, sha256Hex(SQL));

    const after = await columns(db);
    for (const [table, cols] of Object.entries(NEW_COLUMNS)) {
      for (const [name, want] of Object.entries(cols)) {
        const c = after.find((x) => x.tableName === table && x.columnName === name);
        assert.ok(c, `${table}.${name}`);
        assert.deepEqual({ type: c.dataType, nullable: c.isNullable === 'YES', def: c.columnDefault }, want, `${table}.${name}`);
      }
    }
    // только добавляющая: прежние колонки на месте и в том же порядке
    const old = before.map((c) => `${c.tableName}.${c.columnName}`);
    assert.deepEqual(after.map((c) => `${c.tableName}.${c.columnName}`).filter((n) => old.includes(n)), old);
  } finally {
    await db.close();
  }
});

test('файл сам по себе идемпотентен: повторное выполнение не меняет колонки и ограничения', async () => {
  const db = await createTestDb({ register: false });
  try {
    const cols = await columns(db);
    const cons = await constraints(db);
    await db.withTx(async (c) => c.exec(SQL));
    await db.withTx(async (c) => c.exec(SQL));
    assert.deepEqual(await columns(db), cols);
    assert.deepEqual(await constraints(db), cons);
    const via = cons.find((c) => c.conname === 'calls_via_check');
    assert.match(via?.def ?? '', /'board'/);
  } finally {
    await db.close();
  }
});

test('прежние вставки без новых колонок работают; via board принят, чужое значение и выход за CHECK — нет', async () => {
  const db = await openWorld();
  try {
    const sql = db.sql;
    const [card] = await sql<{ id: string; clientId: string }>`SELECT id, client_id FROM cards WHERE space_id = ${SPACE} AND owner_user_id = ${U.opA} ORDER BY id LIMIT 1`;
    assert.ok(card, 'в мире изоляции у оператора A есть карточка');
    const [d] = await sql<Record<string, unknown>>`
      SELECT callback_reason, callback_touches, next_call_precision, attended_group_at, last_no_show_kind, purchases_total, heat
        FROM cards WHERE id = ${card.id}`;
    assert.deepEqual({ ...d }, { callbackReason: '', callbackTouches: 0, nextCallPrecision: 'time', attendedGroupAt: null, lastNoShowKind: '', purchasesTotal: 0, heat: 0 });

    const insertCall = (id: string, via: string) => sql`
      INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
      VALUES (${id}, ${SPACE}, ${card.id}, ${card.clientId}, ${U.opA}, ${via}, 'callback', 'callback', 'applied', ${SEED_NOW}, ${SEED_NOW}, 1)`;
    // прежний набор колонок (код N−1) и новый канал
    await insertCall('00000000-0000-4000-8000-0000000000b1', 'ui');
    await insertCall('00000000-0000-4000-8000-0000000000b2', 'board');
    const rows = await sql<{ via: string; callbackPrecision: string }>`
      SELECT via, callback_precision FROM calls WHERE id IN ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2') ORDER BY id`;
    assert.deepEqual(rows.map((r) => [r.via, r.callbackPrecision]), [['ui', 'time'], ['board', 'time']]);

    const check = (p: Promise<unknown>, name: string) =>
      assert.rejects(p, (e: unknown) => (e as { code?: string; constraint_name?: string }).code === '23514' && (e as { constraint_name?: string }).constraint_name === name, name);
    await check(insertCall('00000000-0000-4000-8000-0000000000b3', 'drag'), 'calls_via_check');
    await check(sql`UPDATE calls SET callback_precision = 'week' WHERE id = '00000000-0000-4000-8000-0000000000b2'`, 'calls_callback_precision_check');
    await check(sql`UPDATE cards SET callback_touches = 10001 WHERE id = ${card.id}`, 'cards_callback_touches_check');
    await check(sql`UPDATE cards SET callback_touches = -1 WHERE id = ${card.id}`, 'cards_callback_touches_check');
    await check(sql`UPDATE cards SET heat = 100001 WHERE id = ${card.id}`, 'cards_heat_check');
    await check(sql`UPDATE cards SET heat = -1 WHERE id = ${card.id}`, 'cards_heat_check');
    await check(sql`UPDATE cards SET next_call_precision = 'week' WHERE id = ${card.id}`, 'cards_next_call_precision_check');
    await check(sql`UPDATE cards SET last_no_show_kind = 'other' WHERE id = ${card.id}`, 'cards_last_no_show_kind_check');
    await check(sql`UPDATE cards SET purchases_total = -1 WHERE id = ${card.id}`, 'cards_purchases_total_check');
    await check(sql`UPDATE tasks SET due_precision = 'week' WHERE space_id = ${SPACE}`, 'tasks_due_precision_check');
    // границы допустимы
    await sql`UPDATE cards SET callback_touches = 10000, heat = 100000, next_call_precision = 'day', last_no_show_kind = 'group' WHERE id = ${card.id}`;
  } finally {
    await closeWorld(db);
  }
});
