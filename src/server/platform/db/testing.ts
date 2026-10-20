// Тестовая БД: временная схема в Postgres 16 из TEST_DATABASE_URL. Каждая БД теста живёт в своей
// схеме (search_path) и удаляется при close(); регистрируется как getDb() этого процесса
// (node --test запускает каждый файл в своём процессе — изоляция по файлу).
import { randomUUID } from 'node:crypto';
import type { DbHandle } from './core';
import { setDb } from './index';
import { migrate } from './migrate';
import { createPostgresDb } from './postgres';

export type TestDb = DbHandle;

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is not set: интеграционные тесты идут на Postgres 16 (см. README).');
  return url;
}

/**
 * migrate: false — пустая база без миграций (проверки состояния миграций).
 * migrationsDir — каталог миграций вместо migrations/ (тесты раннера на временной папке).
 */
export async function createTestDb(
  opts: { register?: boolean; migrate?: boolean; migrationsDir?: string } = {},
): Promise<TestDb> {
  const url = testDatabaseUrl();
  const schema = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = await createPostgresDb(url);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  const base = await createPostgresDb(url, { schema });
  const db: TestDb = {
    ...base,
    close: async () => {
      setDb(null);
      await base.close();
      await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
  if (opts.migrate !== false) await migrate(db, opts.migrationsDir);
  if (opts.register !== false) setDb(db);
  return db;
}
