// Миграция «вариант услуги в покупке» (D-357, docs/pv2-round3.md §4) на Postgres 16: накатывается на базу прежней версии
// (N−1) и с нуля, повторный прогон ничего не меняет, sha256 записан; сделки до миграции получают '' (обратного заполнения
// нет), формат ключа держит CHECK.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate, migrationStatus, sha256Hex } from '../../../src/server/platform/db/migrate';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U, cardOf, clientOf, seedIsolation } from '../../isolation/harness/seed';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const FILE = '2026-10-31-booking-deals-service-variant.sql';
const SQL = readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Каталог миграций по эту включительно или без неё: более поздние файлы не берутся. */
async function migrationsUpTo(through: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crm-migrations-variant-'));
  dirs.push(dir);
  for (const f of await readdir(MIGRATIONS)) {
    if (f.endsWith('.sql') && (f < FILE || (through && f === FILE))) await copyFile(path.join(MIGRATIONS, f), path.join(dir, f));
  }
  return dir;
}

const column = async (db: TestDb) =>
  (
    await db.sql<{ dataType: string; isNullable: string; columnDefault: string | null }>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'deals' AND column_name = 'service_variant_key'`
  )[0];
const dealColumns = (db: TestDb) =>
  db.sql<{ columnName: string; dataType: string; isNullable: string; columnDefault: string | null }>`
    SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'deals' ORDER BY ordinal_position`;
const dealConstraints = (db: TestDb) =>
  db.sql<{ conname: string; def: string }>`
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relnamespace = current_schema()::regnamespace AND t.relname = 'deals' ORDER BY c.conname`;

const checkFails = (p: Promise<unknown>) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === '23514' && (e as { constraint_name?: string }).constraint_name === 'deals_service_variant_key_check');

test('поверх прежней версии: применяется только эта миграция, повтор — ничего, sha256 записан, старая сделка получает пустой вариант', async () => {
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, await migrationsUpTo(false));
    assert.equal(await column(db), undefined, 'в N−1 колонки нет');
    await seedIsolation(db.sql);
    // сделка прежнего кода: колонки варианта нет в INSERT
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at, created_at, updated_at)
                 VALUES ('dl-old-variant', ${SPACE}, 'sales', 'won', 'won', ${clientOf('a', 1)}, ${cardOf('a', 1)}, ${U.opA}, 'smm', 100000, ${SEED_NOW}, ${SEED_NOW}, ${SEED_NOW}, ${SEED_NOW})`;
    const before = await dealColumns(db);

    const cur = await migrationsUpTo(true);
    assert.deepEqual((await migrationStatus(db, cur)).pending, [FILE]);
    assert.deepEqual(await migrate(db, cur), [FILE]);
    assert.deepEqual(await migrate(db, cur), []);
    const st = await migrationStatus(db, cur);
    assert.deepEqual([st.pending, st.changed, st.unknown], [[], [], []]);
    const [row] = await db.sql<{ sha256: string }>`SELECT sha256 FROM schema_migrations WHERE name = ${FILE}`;
    assert.equal(row?.sha256, sha256Hex(SQL));

    const c = await column(db);
    assert.deepEqual({ type: c?.dataType, nullable: c?.isNullable, def: c?.columnDefault }, { type: 'text', nullable: 'NO', def: "''::text" });
    const [old] = await db.sql<{ v: string }>`SELECT service_variant_key AS v FROM deals WHERE id = 'dl-old-variant'`;
    assert.equal(old?.v, '', 'обратного заполнения нет');
    // только добавляющая: прежние колонки на месте и в том же порядке
    const names = before.map((x) => x.columnName);
    assert.deepEqual((await dealColumns(db)).map((x) => x.columnName).filter((n) => names.includes(n)), names);
  } finally {
    await db.close();
  }
});

test('с нуля и повторное выполнение файла: колонки и ограничения не меняются, формат ключа держит CHECK', async () => {
  const db = await createTestDb({ register: false });
  try {
    assert.ok(await column(db), 'в базе с нуля колонка есть');
    const cols = await dealColumns(db);
    const cons = await dealConstraints(db);
    await db.withTx(async (c) => c.exec(SQL));
    await db.withTx(async (c) => c.exec(SQL));
    assert.deepEqual(await dealColumns(db), cols);
    assert.deepEqual(await dealConstraints(db), cons);
    assert.match(cons.find((c) => c.conname === 'deals_service_variant_key_check')?.def ?? '', /service_variant_key/);

    await seedIsolation(db.sql);
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, stage_changed_at, created_at, updated_at)
                 VALUES ('dl-v0', ${SPACE}, 'sales', 'booked', 'open', ${clientOf('a', 1)}, ${cardOf('a', 1)}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW}, ${SEED_NOW})`;
    assert.equal((await db.sql<{ v: string }>`SELECT service_variant_key AS v FROM deals WHERE id = 'dl-v0'`)[0]?.v, '', 'по умолчанию пусто');
    for (const ok of ['', 'online', 'offline_pack_2', 'a'.repeat(64)]) await db.sql`UPDATE deals SET service_variant_key = ${ok} WHERE id = 'dl-v0'`;
    for (const bad of ['Online', 'online-pack', 'пакет', ' x', 'a'.repeat(65)]) await checkFails(db.sql`UPDATE deals SET service_variant_key = ${bad} WHERE id = 'dl-v0'`);
  } finally {
    await db.close();
  }
});
