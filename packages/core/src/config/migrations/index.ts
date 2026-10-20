// Реестр миграций настроек vN → vN+1 (CONFIG §4, D-014, D-060). Чистые функции без БД и времени.
// Правила для новой миграции (пример — README.md рядом):
// - функция работает и на полном документе, и на частичном слое пресета (трогает только то, что есть);
// - не придумывает значения по умолчанию — новые обязательные ключи приходят слоем `base` новой версии,
//   а для живых ревизий миграция ставит значение, равное новому `base` (и это видно в диффе);
// - не удаляет ключи справочников (`archived: true`) и не меняет ключи;
// - результат проверяется схемой новой версии; ошибка останавливает выкладку.
import type { JsonObject } from '../json.js';

export type ConfigScopeKind = 'global' | 'space';

export type ConfigMigration = {
  from: number;
  to: number;
  /** Документ global или слой `global` пресета. */
  global: (doc: JsonObject) => JsonObject;
  /** Документ пространства, слой `spaceDefaults` или `spaces.<key>` пресета. */
  space: (doc: JsonObject) => JsonObject;
};

/** v1 — первая версия: миграций ещё нет. Новая — `v1-to-v2.ts` и строка здесь. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [];
