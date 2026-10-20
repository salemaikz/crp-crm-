# Настройки (ConfigV1) — руководство для builder (P5)

Нормативно: `docs/CONFIG.md`, решения D-014, D-060, D-061, D-081…D-083. Здесь — что уже есть в ядре,
что сделать в платформе и CLI, какие тесты нужны. Ядро (`packages/core/src/config/**`) готово и покрыто
тестами; **его поведение не меняй** — нужна правка схемы или правил слияния → вопрос architect.

Импорт: `@crm/core/config` (файл `index.ts` этого каталога). В `packages/core/src/index.ts` реэкспорт
не добавлен, чтобы не конфликтовать с параллельными задачами; добавит тот, кто будет вливать.

---

## 1. Что уже есть в ядре

| Файл | API | Зачем |
|---|---|---|
| `schema/v1.ts` | `GlobalConfigV1`, `SpaceConfigV1`, `ConfigSetV1` (Zod + типы) | схема CONFIG §6; все ключи обязательны, объекты `.strict()`; набор проверяется целиком |
| `../access/roles.ts` | `RoleSchema` | полная схема роли (права, отношения, `readOnly`, меню); `roleValidator` вызывается из `integrity.ts` с путём `global.roles[i]…` |
| `schema/constants.ts` | `SOURCE_KINDS`, `FIELD_TYPES`, `CAP_KINDS`, `QUEUE_BUCKETS`, `REMINDER_PLACEHOLDERS`, … | закрытые списки (поведение в коде) |
| `integrity.ts` | `checkConfigSet` (внутри схемы) | связи CONFIG §3.3: роли, поля, причины, команды, типы мероприятий, 7 видов итога, won/lost, шаги повторов, белый список подстановок |
| `validate.ts` | `validateConfigSet(x): {ok, value} \| {ok:false, issues[{path, message}]}`, `assertConfigSet`, `ConfigInvalidError` | один вход проверки для пресета, UI, CLI, миграций |
| `layers.ts` | `parseLayer(raw, source)`, `checkLayerChain`, `assembleLayers(layers, {productVersion})`, `satisfiesProduct` | формат слоя и сборка `base → kz → отраслевой → клиент` (D-081) |
| `merge.ts` | `mergeJson(base, overlay)`, `mergeLayers([...])`, `ConfigMergeError` | слияние (D-082); тем же правилом накладывается патч из UI |
| `update.ts` | `presetUpdate({current, prevPreset, nextPreset, force}) → {doc, applied, kept, forced}` | обновление пресета без затирания правок клиента (D-061) |
| `diff.ts` | `diffJson(a, b)`, `formatDiff(changes)` | вывод `config diff/apply/rollback` |
| `paths.ts` | `parsePath`, `formatPath`, `getAt`, `setAt` | `config set`, отчёты; элемент массива — `[key=…]`/`[date=…]` |
| `json.ts` | `Json`, `canonicalJson`, `configHash(doc): Promise<string>`, `deepEqual`, `assertJson` | хэш ревизии = sha256 канонического JSON (D-083) |
| `version.ts` | `CONFIG_SCHEMA_VERSION`, `migrateDoc(kind, doc, from, to?)`, `ConfigVersionError` | миграции настроек `vN → vN+1` |
| `migrations/index.ts` | `CONFIG_MIGRATIONS` (для v1 пусто), `ConfigMigration` | реестр миграций |
| `revisions.ts` | `pickCompatible`, `nextRev`, `lastPresetDoc`, `ActiveConfig`, `RevisionSource`, `GLOBAL_SCOPE` | «последняя совместимая ревизия» (D-060) |
| `steps.ts` | `parseStep` | `+2h`, `+30m`, `nextWorkday@10:00`, `nextEvent:<тип>@10:00` |
| `testing/minimal.ts` | `minimalSet()`, `minimalGlobal()`, `minimalSpace()` | синтетический полный набор для тестов (не пресет `base`) |

Тесты ядра: `packages/core/src/config/*.test.ts` (входят в `npm run test:unit`).

### Модель данных, которую нужно держать в голове

- **Набор** = `{ global, spaces: { <ключ пространства>: doc } }`. Проверяется только целиком
  (`validateConfigSet`): документы пространств ссылаются на роли и поля из `global`.
- **В БД** одна строка `config_revisions` = одна область: `scope = 'global'` или `scope = spaces.id`
  (id, не ключ). Ключ ↔ id — таблица `spaces`.
- Документ в ревизии — **полный** документ области (не дельта). `preset_doc` — собранный пресет этой
  области (тоже полный), пишется только при `source='preset'`.

---

## 2. Платформа: `src/server/platform/config/`

Платформа без Next и без домена (слои D-011). SQL — здесь же (это платформа, не домен).

### 2.1. `repo.ts` — SQL

```ts
type RevRow = ConfigRevision; // revisions.ts: id, scope, rev, schemaVersion, doc, hash, source, presetDoc, note, authorId, createdAt

/** Головы областей: максимальная совместимая rev по каждой области (для дешёвой проверки кэша). */
listHeads(sql, supported: number): Promise<Map<string /*scope*/, number /*rev*/>>
//   SELECT scope, max(rev) AS rev FROM config_revisions WHERE schema_version <= ${supported} GROUP BY scope

/** Последняя совместимая ревизия области (индекс config_revisions_compat_idx). */
loadCompatible(sql, scope, supported): Promise<RevRow | undefined>
//   ... WHERE scope = ${scope} AND schema_version <= ${supported} ORDER BY rev DESC LIMIT 1

loadRevision(sql, scope, rev): Promise<RevRow | undefined>
listRevisionHeads(sql, scope): Promise<{ rev; schemaVersion; source; presetDoc }[]>  // для nextRev и lastPresetDoc
insertRevision(sql, row: Omit<RevRow, 'id' | 'createdAt'> & { now: number }): Promise<RevRow>
listSpaces(sql): Promise<{ id; key; isDefault; enabled }[]>
```

Правила SQL — `src/server/platform/db/index.ts` (tagged template, jsonb через `db.json()`).
`UPDATE`/`DELETE` по `config_revisions` нет и быть не может (у `crm_app` нет прав, D-068).

### 2.2. `active.ts` — геттер (контракт уже в коде, сигнатуру уточнить)

```ts
export async function getActiveConfig(opts?: { now?: number }): Promise<ActiveConfig>; // ActiveConfig — @crm/core/config
export function invalidateConfigCache(): void;
export class ConfigMissingError extends Error {} // нет ни одной совместимой ревизии global → установка не настроена
```

`Promise<unknown>` → `Promise<ActiveConfig>` — сужение, потребители (P4a и др.) не ломаются. Алгоритм:

1. Кэш процесса — в `globalThis` (как драйвер БД: переживает HMR в dev): `{ value, heads, checkedAt }`.
2. Есть `value` и `now − checkedAt < 5000` → вернуть `value` (CONFIG §2: проверка не чаще раза в 5 с).
3. Иначе `listHeads(CONFIG_SCHEMA_VERSION)`. Совпали с `heads` кэша → `checkedAt = now`, вернуть `value`.
4. Иначе перечитать: `loadCompatible` для `global` и для каждого пространства из `listSpaces()`
   (выключенное пространство тоже читается: ключи нужны отчётам). Нет ревизии `global` →
   `ConfigMissingError`. Нет ревизии у пространства из таблицы → тоже ошибка (apply создаёт строки
   `spaces` и ревизии в одной транзакции).
5. Ревизия со `schemaVersion < CONFIG_SCHEMA_VERSION` (выкладка ещё не прогнала миграцию настроек) →
   `migrateDoc` **в памяти**, без записи. Пишет мигрированную ревизию только `crmctl update` (§3.5).
6. `validateConfigSet({ global, spaces: {key: doc} })`. Не прошла → бросить `ConfigInvalidError`
   (fail closed; в лог — scope, rev и пути ошибок, **без содержимого** документа). Записи
   проверяются до вставки, так что это только ошибка миграции или ручной SQL.
7. Single-flight: одновременные вызовы во время перечитывания ждут один промис.
8. `now` — параметр для тестов; по умолчанию `Date.now()` (в платформе можно, в ядре — нет).

`invalidateConfigCache()` обнуляет `checkedAt`: после собственной записи следующий вызов сразу сверяет
головы (CONFIG §2 «после собственной записи — сразу»). Другие процессы (воркер) увидят правку
не позже чем через 5 с.

### 2.3. `write.ts` — запись ревизии

```ts
export async function writeConfig(input: {
  /** Новые документы областей по ключу: 'global' | ключ пространства. Остальные — текущие. */
  docs: { global?: Json; spaces?: Record<string, Json> };
  source: RevisionSource;
  /** Ожидаемая текущая rev по области (UI): не совпала → ConfigConflictError (HTTP 409). */
  expectedRev?: Record<string, number>;
  /** Только source='preset': собранный пресет области (база следующего обновления, D-061). */
  presetDocs?: { global?: Json; spaces?: Record<string, Json> };
  note?: string;
  authorId: string | null;
  now?: number;
}): Promise<{ written: { scope: string; rev: number; hash: string }[]; unchanged: string[] }>;
export class ConfigConflictError extends Error {}
```

В одной транзакции `db.tx`:
1. `SELECT pg_advisory_xact_lock(CONFIG_WRITE_LOCK_KEY)` — добавить ключ в `db/locks.ts`
   (`72_026_102_002`). Записи редкие, одной блокировки на все области достаточно.
2. Прочитать текущие совместимые ревизии всех областей; сверить `expectedRev`.
3. Собрать набор «текущие + новые», `validateConfigSet`. Не прошёл → `ConfigInvalidError`, ничего не писать.
4. По каждой изменяемой области: `hash = await configHash(doc)`. Хэш равен текущему и (для `preset`)
   `preset_doc` равен прошлому → область в `unchanged`, ревизию не писать (повторный apply — без шума).
5. `rev = nextRev(все ревизии области, все версии)` — не «совместимая + 1» (D-083).
6. `INSERT` с `schema_version = CONFIG_SCHEMA_VERSION`. `UNIQUE (scope, rev)` нарушен (гонка мимо
   блокировки) → `ConfigConflictError`.
7. Аудит: `writeAudit` с сущностью `config`. В `AUDIT_ACTIONS` добавить `config.write` (UI/CLI),
   `config.preset`, `config.rollback`, `config.migrate`; в `params` — scope, rev, hash, source, **без
   документа**.
8. После коммита — `invalidateConfigCache()`.

UI (R2b) пишет так: берёт `ActiveConfig`, строит патч, `mergeJson(currentDoc, patch)` (то же правило
слияния, что у слоёв), `writeConfig({ docs, source: 'ui', expectedRev })`.

### 2.4. Проекции настроек в таблицы (только `apply`)

В той же транзакции, что ревизии:
- `spaces`: по `global.spaces[]` — `INSERT … ON CONFLICT (key) DO NOTHING` (id — UUID), затем
  `enabled` и `is_default` из настроек (источник правды — настройки, таблица — проекция для FK и SQL);
- `teams`: по `teams[]` каждого пространства — `INSERT … ON CONFLICT (space_id, key) DO NOTHING`;
  `archived: true` → `archived_at`;
- `event_series` из `booking.seedSeries[]` — только если в пространстве ещё нет ни одной серии (CONFIG §6.9).

Ничего не удаляется.

---

## 3. CLI: `scripts/crmctl/config.ts`

Экспорт `runConfig(argv: string[]): Promise<number>` (код выхода); реестр `scripts/crmctl/index.ts`
ведёт ops (PLAN §4). До реестра — запуск `tsx scripts/crmctl/config.ts <подкоманда> …` (главный блок
под проверкой `import.meta.url`). БД — `DATABASE_URL` (роль `crm_app`: `INSERT` в `config_revisions`
разрешён). Область в аргументах — `global` или **ключ** пространства.

Коды выхода: `0` — успех / нет изменений; `1` — ошибка (аргументы, БД, файл); `2` — `diff` нашёл
изменения; `3` — набор не прошёл проверку (печатаются пути и сообщения); `4` — `ConfigConflictError`.

### 3.1. `config apply --layers <a>,<b>,… [--yes] [--force]`

1. Слой — ключ (`base`, `kz`, `consulting-sales` → `presets/<ключ>/preset.json`) или путь к каталогу
   накладки (`…/clients/<клиент>/` → `preset.json` внутри). `parseLayer(JSON.parse(файл), путь)`.
2. `assembleLayers(layers, { productVersion })` (версия — из `package.json` образа).
3. Для каждой области собранного пресета: `current` = совместимая ревизия; `prevPreset` =
   `lastPresetDoc(ревизии области)`; `presetUpdate({ current, prevPreset, nextPreset, force })`.
   Нет текущей ревизии (первая установка) → документ = пресет.
4. `validateConfigSet` итогового набора. Не прошёл → код 3.
5. Печать: `formatDiff(diffJson(current, doc))` по областям; отдельный блок «оставлено как у клиента»
   (`kept`: путь, у клиента, в пресете) и «перезаписано --force» (`forced`).
6. Без `--yes` — только печать и подсказка «добавьте --yes» (код 0). С `--yes` — `writeConfig`
   с `source: 'preset'`, `presetDocs` = собранный пресет по областям (а не итоговый документ!),
   `note` = `layers: base@2026.10.1, kz@…, …`, плюс проекции §2.4.
7. Ассеты накладки (D-061): каталог `<накладка>/assets/` копируется в том ассетов
   (`CRM_ASSETS_DIR`). Правила: только обычные файлы (симлинки и подкаталоги — ошибка), имя проходит
   `AssetKey` (`^[a-z0-9][a-z0-9._-]{0,99}$`, без `..`), расширения `.svg .png .webp .woff2`, файл
   ≤ 2 МБ, запись через временный файл + rename. `theme.logo` должен ссылаться на существующий ассет
   (ассет образа или скопированный) — проверка в CLI, не в схеме. Отдача ассетов — отдельная задача
   UI-потока (SVG только как `<img>`, `Content-Security-Policy: sandbox`).

### 3.2. `config diff`

- `config diff --layers …` — как `apply` без записи (код 2, если есть изменения);
- `config diff <scope> <revA> <revB>` — `diffJson` двух ревизий области.

### 3.3. `config rollback <scope> <rev> [--yes]`

`loadRevision`; `schemaVersion > CONFIG_SCHEMA_VERSION` → отказ (код 1: эта сборка не знает схему);
меньше — `migrateDoc` в памяти. Печать диффа «текущая → rev». С `--yes` — `writeConfig` с
`source: 'rollback'`, `note: 'rollback to rev N'`. Ревизии не удаляются (CONFIG §2).

### 3.4. `config set <scope> <path> <json> [--yes]` и `config export`

`set`: `setAt(doc, parsePath(path), JSON.parse(json))` → проверка → дифф → `source: 'cli'`.
`export`: печать `{ global, spaces: {key: doc} }` из `ActiveConfig` (для «Полной выгрузки» и переноса).
Обе — по времени после apply/diff/rollback; `set` нужен к 1.11 (поля — через CLI).

### 3.5. Шаг `crmctl update`: `migrateConfigs()`

Функция в `src/server/platform/config/migrate.ts`, вызывает O2 после SQL-миграций: для каждой области
совместимая ревизия со `schemaVersion < CONFIG_SCHEMA_VERSION` → `migrateDoc` → проверка набора →
`writeConfig({ source: 'migration' })`. Ошибка → ненулевой код, выкладка не переключается (CONFIG §4).
Для v1 миграций нет — функция ничего не пишет, но тест на неё есть (§4).

---

## 4. Тесты, которые нужны

Интеграционные (`tests/integration/platform/config-*.test.ts`, `createTestDb()`, `TEST_DATABASE_URL`):

1. **Совместимая ревизия (D-060)**: вставить rev 1 (v1) и rev 2 с `schema_version = 2` руками →
   `getActiveConfig` отдаёт rev 1; `writeConfig` пишет rev **3** с `schema_version = 1`.
2. **Кэш**: два вызова в пределах 5 с (через `now`) — один запрос голов; запись другим «процессом»
   (прямой INSERT) видна только после 5 с; после `writeConfig` этого процесса — сразу.
3. **Single-flight**: 10 параллельных вызовов на холодном кэше — одно перечитывание.
4. **expectedRev**: устаревший → `ConfigConflictError`; две параллельные записи — обе получают разные
   rev или одна 409, уникальность не падает в 500.
5. **Неверный документ не пишется**: `writeConfig` с дырой в связях → `ConfigInvalidError`, ревизий не
   прибавилось.
6. **Хэш**: `hash` в строке = `configHash(doc)` прочитанного из jsonb (порядок ключей БД не влияет).
7. **apply идемпотентен**: второй `apply` тех же слоёв — `unchanged`, новых ревизий нет.
8. **Обновление пресета не затирает правку**: apply → UI-правка `dailyCap` → apply пресета с новым
   `dailyCap` и новым `mode` → `dailyCap` клиента, `mode` из пресета, `kept` содержит `dailyCap`;
   с `--force` — оба из пресета.
9. **rollback**: новая ревизия с содержимым старой, `source='rollback'`, старые на месте.
10. **Проекции**: apply создаёт `spaces`, `teams`, серию из `seedSeries` один раз; повторный apply —
    ничего не дублирует.
11. **Права БД**: под ролью `crm_app` `UPDATE`/`DELETE config_revisions` падает (если не покрыто P2).
12. **migrateConfigs** на v1 — ничего не пишет; с подменённым реестром (параметр) — пишет `migration`.

Юнит (`tests/unit/`): разбор аргументов CLI, коды выхода, печать `kept`/`forced`; проверка ассетов
(симлинк, `..`, лишнее расширение, размер).

Пресеты (O8a): тест «каждый слой парсится, цепочка base → kz → consulting-sales → клиент собирается и
проходит `validateConfigSet`» — в задаче O8a.

---

## 5. Чего не делать

- Не добавлять значения по умолчанию в схему (`.default()`), `.passthrough()` и `.catchall()` — D-060, D-061.
- Не писать дельты в `config_revisions`: только полный документ области.
- Не вычислять `rev` как «совместимая + 1» и не читать «последнюю rev» без фильтра `schema_version`.
- Не класть документ настроек, его фрагменты и секреты в аудит и логи.
- Не вызывать `Date.now()` в ядре; время — параметром.
- Не править `packages/core/src/config/**`: вопрос по схеме или слиянию — architect.

## 6. Как добавить миграцию настроек (после v1)

1. `CONFIG_SCHEMA_VERSION` → N+1; `schema/v{N+1}.ts` (старая схема остаётся для тестов).
2. `migrations/v{N}-to-v{N+1}.ts`: `{ from: N, to: N+1, global(doc), space(doc) }`, работает и на
   частичном слое; строка в `CONFIG_MIGRATIONS`.
3. Слой `base` новой версии содержит новые обязательные ключи; миграция живых ревизий ставит то же
   значение.
4. Тест: каждая ревизия из фикстур vN после миграции проходит схему vN+1; CI «версия N−1 стартует на БД
   и настройках после update до N» (D-060).
