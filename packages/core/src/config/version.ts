// Версия схемы настроек и прогон миграций (D-060). Версия пишется в `config_revisions.schema_version`.
import { cloneJson, type JsonObject } from './json.js';
import { CONFIG_MIGRATIONS, type ConfigMigration, type ConfigScopeKind } from './migrations/index.js';

/** Версия схемы, которую знает эта сборка продукта. */
export const CONFIG_SCHEMA_VERSION = 1;

export class ConfigVersionError extends Error {
  override name = 'ConfigVersionError';
}

/**
 * Привести документ области (или слой пресета) от `from` к `to` цепочкой миграций. Документ новее
 * сборки (`from > to`) — ошибка: прежняя версия его не читает, она берёт свою ревизию (D-060).
 */
export function migrateDoc(
  kind: ConfigScopeKind,
  doc: JsonObject,
  from: number,
  to: number = CONFIG_SCHEMA_VERSION,
  migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS,
): JsonObject {
  if (!Number.isInteger(from) || from < 1) throw new ConfigVersionError(`неверная версия схемы ${from}`);
  if (from > to) throw new ConfigVersionError(`документ версии ${from} новее схемы ${to}: эта сборка его не читает`);
  let cur = cloneJson(doc);
  for (let v = from; v < to; v++) {
    const m = migrations.find((x) => x.from === v && x.to === v + 1);
    if (!m) throw new ConfigVersionError(`нет миграции настроек v${v} → v${v + 1}`);
    cur = m[kind](cloneJson(cur));
  }
  return cur;
}
