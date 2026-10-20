// Раннер миграций на Postgres 16 (TEST_DATABASE_URL) и временной папке миграций.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATION_LOCK_KEY } from '../../../src/server/platform/db/locks';
import { createTestDb } from '../../../src/server/platform/db/testing';
import {
  MigrationChecksumError,
  MigrationsPendingError,
  assertMigrated,
  migrate,
  migrationStatus,
  sha256Hex,
} from '../../../src/server/platform/db/migrate';

const dirs: string[] = [];
async function tmpMigrations(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crm-migrations-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), body);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const A = '2026-10-21-platform-a.sql';
const B = '2026-10-22-platform-b.sql';

test('пустой набор: применяется дважды, учёт создан, ничего не накатано', async () => {
  const dir = await tmpMigrations();
  const db = await createTestDb({ migrate: false, register: false });
  try {
    assert.deepEqual(await migrate(db, dir), []);
    assert.deepEqual(await migrate(db, dir), []);
    const [t] = await db.sql<{ ok: boolean }>`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`;
    assert.equal(t?.ok, true);
    const st = await migrationStatus(db, dir);
    assert.deepEqual({ ...st }, { files: [], applied: [], pending: [], unknown: [], changed: [] });
  } finally {
    await db.close();
  }
});

test('миграции применяются по алфавиту один раз; sha256 записан', async () => {
  const dir = await tmpMigrations({
    [B]: 'CREATE TABLE IF NOT EXISTS t_b (id TEXT PRIMARY KEY);',
    [A]: 'CREATE TABLE IF NOT EXISTS t_a (id TEXT PRIMARY KEY);',
    'README.md': 'не миграция',
  });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    assert.deepEqual(await migrate(db, dir), [A, B]);
    assert.deepEqual(await migrate(db, dir), []);
    const rows = await db.sql<{ name: string; sha256: string }>`SELECT name, sha256 FROM schema_migrations ORDER BY name`;
    assert.deepEqual(rows.map((r) => r.name), [A, B]);
    assert.equal(rows[0]?.sha256, sha256Hex('CREATE TABLE IF NOT EXISTS t_a (id TEXT PRIMARY KEY);'));
    await db.sql`INSERT INTO t_a (id) VALUES ('x')`;
  } finally {
    await db.close();
  }
});

test('изменённый применённый файл — ошибка migrate (D-059), даже если новых файлов нет', async () => {
  const dir = await tmpMigrations({ [A]: 'CREATE TABLE IF NOT EXISTS t_a (id TEXT PRIMARY KEY);' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, dir);
    await writeFile(path.join(dir, A), 'CREATE TABLE IF NOT EXISTS t_a (id TEXT PRIMARY KEY, extra TEXT);');
    await assert.rejects(migrate(db, dir), (e: unknown) => e instanceof MigrationChecksumError && e.changed.join() === A);
    assert.deepEqual((await migrationStatus(db, dir)).changed, [A]);
    // новый файл рядом с изменённым тоже не накатывается
    await writeFile(path.join(dir, B), 'SELECT 1;');
    await assert.rejects(migrate(db, dir), MigrationChecksumError);
    const names = await db.sql<{ name: string }>`SELECT name FROM schema_migrations`;
    assert.deepEqual(names.map((r) => r.name), [A]);
  } finally {
    await db.close();
  }
});

test('ошибка в файле откатывает всю накатку', async () => {
  const dir = await tmpMigrations({
    [A]: 'CREATE TABLE IF NOT EXISTS t_a (id TEXT PRIMARY KEY);',
    [B]: 'THIS IS NOT SQL;',
  });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await assert.rejects(migrate(db, dir));
    const [t] = await db.sql<{ ok: boolean }>`SELECT to_regclass('t_a') IS NOT NULL AS ok`;
    assert.equal(t?.ok, false);
    const st = await migrationStatus(db, dir);
    assert.deepEqual(st.pending, [A, B]);
  } finally {
    await db.close();
  }
});

test('assertMigrated: ненакатанные — ошибка со списком; параллельная накатка применяет файл один раз', async () => {
  const dir = await tmpMigrations({ [A]: 'CREATE TABLE t_a (id TEXT PRIMARY KEY);' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await assert.rejects(assertMigrated(db, dir), MigrationsPendingError);
    const results = await Promise.all([migrate(db, dir), migrate(db, dir), migrate(db, dir)]);
    assert.equal(results.flat().length, 1);
    await assertMigrated(db, dir);
  } finally {
    await db.close();
  }
});

test('незнакомая накатанная миграция (откат релиза) — не ошибка', async () => {
  const dir = await tmpMigrations({ [A]: 'SELECT 1;', [B]: 'SELECT 1;' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, dir);
    await rm(path.join(dir, B));
    assert.deepEqual(await migrate(db, dir), []);
    assert.deepEqual((await migrationStatus(db, dir)).unknown, [B]);
  } finally {
    await db.close();
  }
});

test('файл .sql с неверным именем — ошибка, а не молчаливый пропуск', async () => {
  const dir = await tmpMigrations({ [A]: 'SELECT 1;', '2026-10-22-calling_fix.sql': 'SELECT 1;' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await assert.rejects(migrate(db, dir), /2026-10-22-calling_fix\.sql/);
    await assert.rejects(migrationStatus(db, dir), /Неверное имя/);
  } finally {
    await db.close();
  }
});

test('assertMigrated: изменённый применённый файл — MigrationChecksumError', async () => {
  const dir = await tmpMigrations({ [A]: 'SELECT 1;' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, dir);
    await assertMigrated(db, dir);
    await writeFile(path.join(dir, A), 'SELECT 2;');
    await assert.rejects(assertMigrated(db, dir), (e: unknown) => e instanceof MigrationChecksumError && e.changed.join() === A);
  } finally {
    await db.close();
  }
});

test('lock_timeout действует и на advisory-блокировку: занятая блокировка не вешает migrate', async () => {
  const dir = await tmpMigrations({ [A]: 'SELECT 1;' });
  const db = await createTestDb({ migrate: false, register: false });
  try {
    await migrate(db, await tmpMigrations()); // создать schema_migrations
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = db.withTx(async (c) => {
      await c.sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      locked();
      await held;
    });
    await lockedP;
    const t0 = Date.now();
    try {
      await assert.rejects(migrate(db, dir, { lockTimeoutMs: 300 }), /lock timeout/i);
      assert.ok(Date.now() - t0 < 5000, 'ожидание ограничено lock_timeout');
    } finally {
      release();
      await holder;
    }
    assert.deepEqual(await migrate(db, dir), [A]);
  } finally {
    await db.close();
  }
});
