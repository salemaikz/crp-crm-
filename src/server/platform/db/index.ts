// Точка входа слоя БД: postgres.js, один драйвер. Источник: платформа LMS 2cd8a2b src/lib/db/index.ts.
//
// Правила SQL:
// - только tagged template со значениями в ${}; без вложенных sql``, sql(obj), sql.unsafe, склейки строк;
// - списки: = ANY(${ids}); jsonb: ${db.json(v)}, читается уже объектом;
// - колонки snake_case в БД → camelCase в строках; BIGINT → number;
// - внутри db.tx(fn) используйте sql из колбэка (вызовы db.sql тоже попадут в транзакцию).
import { databaseUrl, type Env } from '../env';
import type { Db, DbHandle } from './core';
import { assertMigrated, migrate } from './migrate';

export type { Db, DbHandle, Row, Sql } from './core';
export { isUniqueViolation } from './core';

type DbGlobal = typeof globalThis & { __crmDb?: { promise: Promise<DbHandle> } };
const g = globalThis as DbGlobal;

/** Открыть драйвер без миграций (скрипты npm run db:*). */
export async function openDriver(url?: string): Promise<DbHandle> {
  const target = url ?? databaseUrl(); // нет DATABASE_URL — ошибка, а не тихая БД в памяти
  const { createPostgresDb } = await import('./postgres');
  return createPostgresDb(target);
}

/**
 * Накатывать миграции при старте. DB_MIGRATE_ON_START=1 — да, 0 — нет; иначе да только в development
 * и test. В production DDL применяет выкладка (контейнер migrate под crm_owner): у роли приложения
 * права на DDL нет, приложение только проверяет, что всё накатано.
 */
export function autoMigrateEnabled(env: Env = process.env): boolean {
  const v = env.DB_MIGRATE_ON_START?.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
}

/** Подготовка открытого драйвера: migrate (autoMigrate) или assertMigrated. */
export async function prepareDb(db: DbHandle, opts: { autoMigrate?: boolean } = {}): Promise<void> {
  if (opts.autoMigrate ?? autoMigrateEnabled()) await migrate(db);
  else await assertMigrated(db);
}

/**
 * Открыть БД для скрипта (воркер, CLI) по шаблону: драйвер → assertMigrated → setDb.
 * Возвращает функцию закрытия.
 */
export async function openScriptDb(): Promise<() => Promise<void>> {
  const db = await openDriver();
  try {
    await assertMigrated(db);
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  setDb(db);
  return async () => {
    setDb(null);
    await db.close();
  };
}

async function init(): Promise<DbHandle> {
  const db = await openDriver();
  try {
    await prepareDb(db);
    return db;
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
}

/**
 * Ленивая инициализация: драйвер → миграции (в production — только проверка).
 * Один экземпляр на процесс (переживает hot reload); параллельные вызовы ждут один промис.
 */
export function getDb(): Promise<Db> {
  if (!g.__crmDb) {
    const promise = init().catch((e) => {
      g.__crmDb = undefined; // следующий вызов попробует снова
      throw e;
    });
    g.__crmDb = { promise };
  }
  return g.__crmDb.promise;
}

/** Только для тестов и скриптов: подставить готовый экземпляр вместо ленивого. */
export function setDb(db: DbHandle | null): void {
  g.__crmDb = db ? { promise: Promise.resolve(db) } : undefined;
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function now(): number {
  return Date.now();
}
