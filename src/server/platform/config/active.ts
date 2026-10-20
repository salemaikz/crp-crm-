// Геттер настроек (контракт между документом настроек и потребителями: доступ, раздача и др.).
// Нормативно: docs/CONFIG.md §2, D-060. Алгоритм — packages/core/src/config/README.md §2.2.
// Потребитель сам проверяет нужный ему раздел своей схемой Zod; здесь набор уже проверен целиком.
import { config as coreConfig } from '@crm/core';
import type { ActiveConfig, ConfigRevision, ConfigMigration, JsonObject } from '@crm/core/config';
import { getDb, type Sql } from '../db';
import { listHeads, listSpaces, loadCompatible } from './repo';

const { CONFIG_SCHEMA_VERSION, ConfigInvalidError, migrateDoc, validateConfigSet } = coreConfig;

/** Не чаще раза в 5 с проверяем головы ревизий (CONFIG §2). */
export const CONFIG_CHECK_INTERVAL_MS = 5000;

/** Нет ни одной совместимой ревизии: установка не настроена (crmctl config apply). */
export class ConfigMissingError extends Error {
  override name = 'ConfigMissingError';
}

type Cache = {
  value: ActiveConfig | null;
  heads: Map<string, number> | null;
  checkedAt: number;
  /** Идущее сейчас перечитывание: одновременные вызовы ждут один промис (single-flight). */
  inflight: Promise<ActiveConfig> | null;
  /** Сколько раз читали голову ревизий / тело — для тестов кэша. */
  stats: { headChecks: number; reloads: number };
};

type CacheGlobal = typeof globalThis & { __crmConfigCache?: Cache };
const g = globalThis as CacheGlobal;

function cache(): Cache {
  g.__crmConfigCache ??= { value: null, heads: null, checkedAt: 0, inflight: null, stats: { headChecks: 0, reloads: 0 } };
  return g.__crmConfigCache;
}

/** После собственной записи следующий вызов сразу сверяет головы (CONFIG §2). */
export function invalidateConfigCache(): void {
  cache().checkedAt = 0;
}

/** Полный сброс кэша (тесты, смена БД). */
export function resetConfigCache(): void {
  g.__crmConfigCache = undefined;
}

export function configCacheStats(): { headChecks: number; reloads: number } {
  return { ...cache().stats };
}

function sameHeads(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Документ ревизии в формате текущей схемы: старше — миграция в памяти, без записи (README §2.2 п. 5). */
export function docOf(rev: ConfigRevision, kind: 'global' | 'space', migrations?: readonly ConfigMigration[], target = CONFIG_SCHEMA_VERSION): JsonObject {
  const doc = rev.doc as JsonObject;
  if (rev.schemaVersion >= target) return doc;
  return migrateDoc(kind, doc, rev.schemaVersion, target, migrations);
}

/** Прочитать и проверить весь набор. Бросает ConfigMissingError или ConfigInvalidError (fail closed). */
async function loadAll(sql: Sql): Promise<ActiveConfig> {
  const gl = await loadCompatible(sql, 'global', CONFIG_SCHEMA_VERSION);
  if (!gl) throw new ConfigMissingError('нет ревизии настроек global: выполните crmctl config apply');
  const spaces = await listSpaces(sql);
  const revs: { key: string; id: string; rev: ConfigRevision }[] = [];
  for (const s of spaces) {
    const r = await loadCompatible(sql, s.id, CONFIG_SCHEMA_VERSION);
    if (!r) throw new ConfigMissingError(`нет ревизии настроек пространства «${s.key}»`);
    revs.push({ key: s.key, id: s.id, rev: r });
  }
  const set = { global: docOf(gl, 'global'), spaces: Object.fromEntries(revs.map((r) => [r.key, docOf(r.rev, 'space')])) };
  const check = validateConfigSet(set);
  if (!check.ok) {
    // В лог — область, номер ревизии и пути ошибок, без содержимого документа
    const where = [`global@${gl.rev}`, ...revs.map((r) => `${r.key}@${r.rev.rev}`)].join(', ');
    console.error(`[config] набор не прошёл проверку (${where}): ${check.issues.map((i) => i.path).join(', ')}`);
    throw new ConfigInvalidError(check.issues);
  }
  return {
    rev: gl.rev,
    global: { ...check.value.global, rev: gl.rev, hash: gl.hash, doc: check.value.global },
    spaces: Object.fromEntries(revs.map((r) => [r.key, { spaceId: r.id, rev: r.rev.rev, hash: r.rev.hash, doc: check.value.spaces[r.key]! }])),
    schemaVersion: CONFIG_SCHEMA_VERSION,
  };
}

/**
 * Активные настройки. Кэш процесса: проверка голов ревизий не чаще раза в 5 с; изменились — набор
 * перечитывается одним запросом-на-всех (single-flight). `now` — для тестов.
 */
export async function getActiveConfig(opts: { now?: number } = {}): Promise<ActiveConfig> {
  const c = cache();
  const now = opts.now ?? Date.now();
  if (c.value && now - c.checkedAt < CONFIG_CHECK_INTERVAL_MS) return c.value;
  if (c.inflight) return c.inflight;
  const p = (async () => {
    try {
      const db = await getDb();
      if (c.value && c.heads) {
        c.stats.headChecks++;
        const heads = await listHeads(db.sql, CONFIG_SCHEMA_VERSION);
        if (sameHeads(heads, c.heads)) {
          c.checkedAt = now;
          return c.value;
        }
      }
      c.stats.reloads++;
      // Головы читаем до тела: запись, прошедшая между чтениями, даст при следующей проверке расхождение
      const { heads, value } = await db.tx(async (sql) => ({ heads: await listHeads(sql, CONFIG_SCHEMA_VERSION), value: await loadAll(sql) }));
      c.value = value;
      c.heads = heads;
      c.checkedAt = now;
      return value;
    } finally {
      c.inflight = null;
    }
  })();
  c.inflight = p;
  return p;
}

/**
 * Активные настройки или null, если установка ещё не настроена (нет ни одной ревизии). Недействительный
 * набор по-прежнему бросает ConfigInvalidError: оболочка и пояс не подменяются тихими умолчаниями.
 */
export async function getActiveConfigOrNull(opts: { now?: number } = {}): Promise<ActiveConfig | null> {
  try {
    return await getActiveConfig(opts);
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

/** Чтение без кэша в переданной транзакции (запись, CLI export). */
export const loadActiveConfig = loadAll;
