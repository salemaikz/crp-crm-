// Ключи advisory-блокировок Postgres: все в одном месте, чтобы значения не пересеклись.
import type { Db } from './core';

/** Накатка миграций: параллельные процессы не применяют их одновременно. */
export const MIGRATION_LOCK_KEY = 72_026_102_001;

/** Запись ревизии настроек: одна блокировка на все области, записи редкие (CONFIG §2). */
export const CONFIG_WRITE_LOCK_KEY = 72_026_102_002;

/** Приём клиентов: проверка и добавление номеров, загрузка, ручное создание идут по одной (D-022). */
export const INTAKE_LOCK_KEY = 72_026_102_003;

/** Сессионная advisory-блокировка, снятие. */
export interface HeldLock {
  release(): Promise<void>;
}

/**
 * Попытка взять сессионную блокировку `pg_try_advisory_lock(classId, hashtext(key))` на выделенном
 * соединении. null — занята другим процессом. Если процесс умер, соединение закрывается и Postgres
 * снимает блокировку сам. Класс блокировки — int4.
 */
export async function tryAdvisoryLock(db: Db, classId: number, key: string): Promise<HeldLock | null> {
  if (!db.reserve) throw new Error('tryAdvisoryLock: драйвер не умеет выделять соединение');
  const conn = await db.reserve();
  try {
    const [row] = await conn.sql<{ ok: boolean }>`SELECT pg_try_advisory_lock(${classId}::int, hashtext(${key})) AS ok`;
    if (!row?.ok) {
      await conn.release();
      return null;
    }
  } catch (e) {
    await conn.release().catch(() => {});
    throw e;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await conn.sql`SELECT pg_advisory_unlock(${classId}::int, hashtext(${key}))`;
      } finally {
        await conn.release();
      }
    },
  };
}
