// Раннер миграций: migrations/*.sql по алфавиту, учёт в schema_migrations вместе с sha256 файла.
// Применённый файл не правится никогда (D-059): если содержимое изменилось, migrate падает.
// Источник: платформа LMS 2cd8a2b src/lib/db/migrate.ts, сверка контрольных сумм — своя.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db, DbHandle } from './core';
import { MIGRATION_LOCK_KEY } from './locks';

const NAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.sql$/;

export function migrationsDir(): string {
  // Подмена каталога — только для тестов и разработки. В production молча игнорировать её нельзя:
  // приложение и ручной db:status разошлись бы в наборе файлов, поэтому это ошибка конфигурации
  const override = process.env.MIGRATIONS_DIR?.trim();
  if (override && process.env.NODE_ENV === 'production') {
    throw new Error('MIGRATIONS_DIR задан в production: переменная только для тестов и разработки, уберите её из окружения.');
  }
  return override || path.join(process.cwd(), 'migrations');
}

/** Файлы миграций по алфавиту. Пустой каталог допустим (до влития схемы); несуществующий — ошибка. */
export async function listMigrations(dir = migrationsDir()): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => NAME_RE.test(f)).sort();
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

export type MigrationStatus = {
  /** На диске, по алфавиту. */
  files: string[];
  /** В schema_migrations. */
  applied: string[];
  /** На диске, но не накатаны. */
  pending: string[];
  /** Накатаны, но файла нет (БД новее кода — норма после отката релиза). */
  unknown: string[];
  /** Накатаны, но содержимое файла на диске отличается от записанного sha256 (D-059). */
  changed: string[];
};

/** Чистое сравнение списков и контрольных сумм: результат отсортирован. */
export function diffMigrations(
  files: string[],
  applied: string[],
  diskHashes: Record<string, string> = {},
  appliedHashes: Record<string, string> = {},
): MigrationStatus {
  const f = [...new Set(files)].sort();
  const a = [...new Set(applied)].sort();
  const onDisk = new Set(f);
  const done = new Set(a);
  return {
    files: f,
    applied: a,
    pending: f.filter((n) => !done.has(n)),
    unknown: a.filter((n) => !onDisk.has(n)),
    changed: a.filter((n) => onDisk.has(n) && diskHashes[n] !== undefined && diskHashes[n] !== appliedHashes[n]),
  };
}

export class MigrationChecksumError extends Error {
  constructor(readonly changed: string[]) {
    super(
      `Применённые миграции изменены (${changed.length}): ${changed.join(', ')}. ` +
        'Применённый файл не правится (D-059): верните исходное содержимое и добавьте новый файл.',
    );
    this.name = 'MigrationChecksumError';
  }
}

export class MigrationsPendingError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `Не накатаны миграции (${pending.length}): ${pending.join(', ')}. ` +
        'Выполните npm run db:migrate от роли с правом на DDL.',
    );
    this.name = 'MigrationsPendingError';
  }
}

/**
 * Состояние миграций. Только SELECT: работает от роли приложения без права на DDL.
 * Нет таблицы schema_migrations — все файлы pending.
 */
export async function migrationStatus(db: Pick<Db, 'sql'>, dir = migrationsDir()): Promise<MigrationStatus> {
  const files = await listMigrations(dir);
  const [t] = await db.sql<{ ok: boolean }>`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`;
  const rows = t?.ok ? await db.sql<{ name: string; sha256: string }>`SELECT name, sha256 FROM schema_migrations` : [];
  const appliedHashes = Object.fromEntries(rows.map((r) => [r.name, r.sha256]));
  const diskHashes: Record<string, string> = {};
  for (const name of files) {
    if (name in appliedHashes) diskHashes[name] = sha256Hex(await readFile(path.join(dir, name)));
  }
  return diffMigrations(files, rows.map((r) => r.name), diskHashes, appliedHashes);
}

/** Fail closed: есть ненакатанные миграции — ошибка со списком. Лишние накатанные (БД новее) — не ошибка. */
export async function assertMigrated(db: Pick<Db, 'sql'>, dir = migrationsDir()): Promise<void> {
  const { pending } = await migrationStatus(db, dir);
  if (pending.length > 0) throw new MigrationsPendingError(pending);
}

/**
 * Применяет ненакатанные миграции в одной транзакции под advisory-блокировкой. Возвращает имена
 * применённых. Сначала сверяет sha256 уже применённых файлов: расхождение — MigrationChecksumError.
 * lockTimeoutMs — сколько ждать блокировку таблицы (lock_timeout действует до конца транзакции).
 */
export async function migrate(
  db: DbHandle,
  dir = migrationsDir(),
  opts: { lockTimeoutMs?: number } = {},
): Promise<string[]> {
  const before = await migrationStatus(db, dir);
  if (before.changed.length > 0) throw new MigrationChecksumError(before.changed);
  const [t] = await db.sql<{ ok: boolean }>`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`;
  // Нечего накатывать и учёт уже есть — ни транзакции, ни блокировки, ни DDL: роль без права CREATE
  // не должна падать на актуальной схеме
  if (before.pending.length === 0 && t?.ok) return [];
  return db.withTx(async (c) => {
    await c.sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
    if (opts.lockTimeoutMs !== undefined) {
      if (!Number.isSafeInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs < 0) {
        throw new Error('lockTimeoutMs must be a non-negative integer');
      }
      await c.sql`SELECT set_config('lock_timeout', ${String(opts.lockTimeoutMs)}, true)`;
    }
    await c.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL, sha256 TEXT NOT NULL)',
    );
    // Под блокировкой список читаем заново: параллельный процесс мог накатить часть файлов
    const done = new Map(
      (await c.sql<{ name: string; sha256: string }>`SELECT name, sha256 FROM schema_migrations`).map((r) => [r.name, r.sha256]),
    );
    const files = await listMigrations(dir);
    const applied: string[] = [];
    for (const name of files) {
      const content = await readFile(path.join(dir, name));
      const hash = sha256Hex(content);
      const prev = done.get(name);
      if (prev !== undefined) {
        if (prev !== hash) throw new MigrationChecksumError([name]);
        continue;
      }
      await c.exec(content.toString('utf8'));
      await c.sql`INSERT INTO schema_migrations (name, applied_at, sha256) VALUES (${name}, ${Date.now()}, ${hash})`;
      applied.push(name);
    }
    return applied;
  });
}
