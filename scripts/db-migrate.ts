// npm run db:migrate — накатить миграции на MIGRATE_DATABASE_URL (или DATABASE_URL).
// npm run db:status (--status) — только чтение: накатанные, ненакатанные, незнакомые и изменённые файлы.
// Коды выхода (контракт выкладки): 0 — всё накатано, 3 — есть ненакатанные,
// 4 — применённый файл изменён (D-059), 1 — ошибка (в том числе настройки и неверные аргументы).
// Источник: платформа LMS 2cd8a2b scripts/db-migrate.ts.
import { openDriver } from '../src/server/platform/db';
import { MigrationChecksumError, migrate, migrationStatus } from '../src/server/platform/db/migrate';
import { migrateDatabaseUrl } from '../src/server/platform/env';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;

/** MIGRATE_LOCK_TIMEOUT_MS: целое положительное число миллисекунд. */
function lockTimeoutMs(raw = process.env.MIGRATE_LOCK_TIMEOUT_MS): number {
  const v = raw?.trim();
  if (!v) return DEFAULT_LOCK_TIMEOUT_MS;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`MIGRATE_LOCK_TIMEOUT_MS должно быть целым положительным числом (мс), получено: ${v}`);
  }
  return n;
}

async function status(): Promise<number> {
  const db = await openDriver(migrateDatabaseUrl()); // без накатки
  try {
    const st = await migrationStatus(db);
    // Строка для скриптов выкладки; дальше — имена для человека
    console.log(
      `applied=${st.applied.length - st.unknown.length} pending=${st.pending.length} unknown=${st.unknown.length} changed=${st.changed.length}`,
    );
    const list = (title: string, items: string[]) =>
      console.log(`${title} (${items.length})${items.length ? `:\n  ${items.join('\n  ')}` : ''}`);
    list('Накатаны', st.applied.filter((n) => !st.unknown.includes(n)));
    list('Не накатаны', st.pending);
    list('Незнакомые (накатаны, файла нет)', st.unknown);
    list('Изменены после накатки (D-059)', st.changed);
    if (st.changed.length > 0) return 4;
    return st.pending.length > 0 ? 3 : 0;
  } finally {
    await db.close();
  }
}

async function apply(): Promise<number> {
  const timeout = lockTimeoutMs();
  const db = await openDriver(migrateDatabaseUrl());
  try {
    const applied = await migrate(db, undefined, { lockTimeoutMs: timeout });
    console.log(applied.length ? `Применены миграции: ${applied.join(', ')}` : 'Новых миграций нет.');
    return 0;
  } catch (e) {
    if (e instanceof MigrationChecksumError) {
      console.error(e.message);
      return 4;
    }
    throw e;
  } finally {
    await db.close();
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 0) return apply();
  if (args.length === 1 && args[0] === '--status') return status();
  console.error(
    'Использование: db-migrate.ts [--status]\n  без аргументов — накатить миграции\n  --status — показать состояние: код 0 — всё накатано, 3 — есть ненакатанные, 4 — применённый файл изменён, 1 — ошибка',
  );
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
