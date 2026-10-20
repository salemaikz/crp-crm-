# Импорт таблиц — дизайн C4d для builder (C4, 23–24.10)

Нормативно для C4: решения D-111…D-116 (`docs/DECISIONS.md`), D-048 (ключи), D-021 (стоп-лист),
D-022 (блокировка приёма), D-050 (перезвон), D-052 (ИП и ИИН), D-067 (автор-система `NULL`).
Опирается на PROCESS 2.2, 3.5, 3.7, 12.14, 12.39; CONFIG §6.4, §6.13; ARCHITECTURE §4.4–4.6, §5;
схему v1 (`docs/schema-v1.md`). **Новых миграций нет**: всё ложится на таблицы v1.

Сигнатуры уже в коде, тела пишет builder, сигнатуры не меняет (правка — через architect):
`src/server/platform/files/{types,index}.ts`, `src/server/domain/import/types.ts`.
Чистое ядро уже есть: `@crm/core` → `imports.parseSheet`, `imports.buildPreview`, ключи D-048
(`rowKeyOf`, `stateKeyOf`, `importKeyOf`), `decideReimport`, `resolveOwner`, `ruleOverlaps`.
Ядро импортируется только как `import { imports, dedup, calling } from '@crm/core'` (D-101).

## 1. Поток

```
РОП: файл + профиль + лист + дата снимка
  → POST /api/import/uploads (сырое тело ≤ maxFileMb)                         §3
  → readSpreadsheet: сигнатура, пределы zip, XML без DOCTYPE, сетка ≤ строк/колонок
  → imports.parseSheet(профиль) → imports (preview) + import_rows (parsed, 14 дней)   §5
РОП: карта «ярлык → учётка»
  → POST /api/import/[id]/preview → buildPreview по строкам + состоянию БД
  → сводка: каждому оператору N карточек, спорные, ошибки, на разбор; отпечаток    §6
РОП: «Применить» (отпечаток + та же карта)
  → POST /api/import/[id]/apply: блокировка импорта → блокировка приёма → пересчёт →
    отпечаток совпал → пакетная запись одной транзакцией → status applied          §7
```

Повторная загрузка (тот же файл, ночная дозагрузка) идёт тем же путём; ключи D-048 решают
«пропуск / один звонок / оставлено как в CRM» (§8).

## 2. Решения (кратко; полностью — DECISIONS)

| № | Что |
|---|---|
| D-111 | XLSX читает свой минимальный ридер: ZIP-каталог + `node:zlib` с пределом на выход + `saxes@6.0.0` (единственная новая зависимость). SheetJS, exceljs, read-excel-file — нет |
| D-112 | Загрузка — сырое тело (`application/octet-stream`), не multipart; файл не хранится; разбор в веб-процессе, один одновременно |
| D-113 | Применение — одна транзакция под `pg_try_advisory_xact_lock(IMPORT_APPLY_LOCK_KEY)` и блокировкой приёма; только при совпадении отпечатка предпросмотра (сборка, ревизии настроек, карта владельцев, решение по каждой строке) |
| D-114 | Прошлое состояние строки — `client_sources(source_key, external_id = rowKey)` + событие ленты `import.row` с `stateKey`; новая таблица не нужна |
| D-115 | Состояние карточки из итога таблицы — чистая функция `imports.planImportedCard`; «Подтвержден» — через `calling.applyOutcome(import_agreed)`; задержанные и без владельца строки с рабочим итогом встают `new`, итог — в ленте |
| D-116 | Права: только `import.run` (РОП); администратор без роли не импортирует; флаг `FEATURE_IMPORT`; профиль в C4 — выбор из настроек, редактор — после пилота |

## 3. Приём файла (`src/server/platform/files/**`)

### 3.1. Транспорт

- `POST /api/import/uploads?profile=<key>&sheet=<имя|номер>&snapshotDay=YYYY-MM-DD`, тело — байты
  файла, `Content-Type: application/octet-stream`, имя — заголовок `X-File-Name` (`encodeURIComponent`).
  Клиент шлёт `fetch(url, { method: 'POST', body: file })`. **Не** `req.formData()`: Next читает
  multipart целиком без предела.
- `readBodyLimited(req, maxBytes)`: `maxBytes = min(import.maxFileMb·MiB, FILE_LIMITS.maxBytesHard)`;
  `Content-Length` больше — 413 до чтения; поток считается побайтно, превышение — `cancel()` и 413.
  nginx уже режет на `client_max_body_size 10m`.
- Файл живёт только в памяти запроса: не пишется ни на диск (`/tmp` — tmpfs 64 МБ, контейнер
  read-only), ни в БД. В `imports` — `file_sha256`, имя (≤ 120 символов, без управляющих), размер.

### 3.2. Сигнатура (`sniffSpreadsheet`)

| Голова файла | Итог |
|---|---|
| `PK\x03\x04` → каталог ZIP → `[Content_Types].xml` → `classifyOoxml` | `xlsx`; `vbaProject.bin`, `activeX/`, `macroEnabled` → `macro`; DOCX, ODS, XLSB, «и то и другое» → `bad_type` |
| `D0 CF 11 E0 A1 B1 1A E1` (OLE2: старый .xls, зашифрованный XLSX) | `legacy_xls` («сохраните как XLSX или CSV») |
| `%PDF`, PNG, JPEG, GIF, `RIFF`, байт `0x00` в первых 64 КБ | `bad_type` |
| BOM UTF-16/UTF-32 | `unsupported_encoding` |
| остальное | CSV: BOM `EF BB BF` или валидный UTF-8 (`new TextDecoder('utf-8', {fatal: true})`) → `utf-8`; иначе `windows-1251` (Excel «CSV (разделители)» в русской Windows; Node 22 с full-icu его знает) |

Расширение и `Content-Type` клиента не учитываются вовсе.

### 3.3. ZIP: защита от бомб (`zip.ts`, `ooxml.ts`)

Перенос `src/lib/storage/{zip,ooxml}.ts` платформы LMS 2cd8a2b (белый список ARCHITECTURE §9.2) с
переделкой с `FileHandle` на `Uint8Array`. Шапка `Источник: платформа LMS 2cd8a2b <путь>`.

- Читается только центральный каталог и **пять частей**: `[Content_Types].xml`, `xl/workbook.xml`,
  `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml` (если есть), `xl/styles.xml` (если есть) и
  выбранный лист (путь — из rels, а не `sheet1.xml`). Остальные записи не распаковываются.
- Отказ `zip_limits`: ZIP64, записей > 1 000, каталог > 1 МиБ, каталог или запись за пределами файла,
  имя с `..`, `/` в начале или `\0`, объявленный размер части больше её предела (`FILE_LIMITS`).
- Распаковка: `inflateRawSync(data, { maxOutputLength: entry.size })` — **предел = объявленный размер**,
  а он уже ограничен пределом части. Лживый размер → ошибка inflate → `corrupt`. Сумма распакованного
  ≤ 96 МиБ. Метод сжатия только 0 и 8; зашифрованная запись (бит 0 флагов) → `corrupt`.
- Распакованный `Buffer` подаётся в `saxes` кусками по 1 МиБ через `TextDecoder` с `stream: true` —
  весь XML строкой в куче не держим.

### 3.4. Разбор XLSX (`xlsx/*.ts`, `saxes@6.0.0`)

- `new SaxesParser({ xmlns: false })`; имена элементов сравниваются по локальной части (после `:`),
  чтобы читались и Strict OOXML-файлы. Событие `doctype` → `xml_doctype` (сущности DTD saxes и так не
  раскрывает: «миллиард смехов» и XXE невозможны). Внешних ресурсов парсер не загружает.
- `workbook.xml`: листы (`<sheet name r:id>`), `date1904`. `rels`: `r:id` → путь листа (только внутри
  `xl/`, нормализация пути, выход за `xl/` → `corrupt`).
- `sharedStrings.xml`: `<si>` = конкатенация всех `<t>` (в том числе внутри `<r>`), `<rPh>`
  (фонетика) пропускается; число строк ≤ 1 000 000.
- `styles.xml`: `cellXfs` → `numFmtId`; дата — встроенные id 14–22, 27–36, 45–47, 50–58 и свои
  `numFmt`, где в коде формата вне кавычек и `[...]` есть `d`, `m`+`y`, `y`, `h`, `s`.
- Лист: `<row r>` задаёт номер строки, **пропуски заполняются пустыми строками** (иначе сдвинется
  «диапазон строк → оператор»); `r` > `limits.maxRows` → `too_many_rows`. Ссылка ячейки `A1…` →
  индекс колонки; колонка ≥ 64 отбрасывается (`droppedColumns`).
- Значение ячейки по `t`: `s` → общая строка; `inlineStr` → `<is><t>`; `str` → `<v>`; `b` → `0`/`1`;
  `e` → пусто (`errorCells`); `n` или без `t` → текст `<v>` как есть (77091234567 не превращается в
  `7.7e10`), а при формате даты — `YYYY-MM-DD` или `YYYY-MM-DD HH:MM` (серийное число от 1899-12-30,
  с поправкой `date1904`, арифметика в UTC). `<f>` (формула) не читается и не вычисляется; нет `<v>` —
  пусто (`formulaWithoutValue`).
- Ячейка длиннее 4 000 символов обрезается (`truncatedCells`). Управляющие символы, кроме `\n` и `\t`,
  удаляются.

### 3.5. CSV (`csv.ts`)

Декодирование (§3.2) → `imports.parseCsvRecords` из ядра → те же пределы строк, колонок и длины.
**Правка ядра (задача C4-core):** разделитель сейчас определяется по первой строке, а у таблиц
операторов первая строка — баннер без разделителей; выбирать `;`, `,` или `\t` по первым 10 непустым
строкам вне кавычек (чего больше в сумме). Тест: баннер + `;`.

### 3.6. Выгрузка и формулы

Импорт **не выполняет** формулы (только сохранённое значение) и хранит текст как есть. Защита — на
выходе: любая CSV-выгрузка строк импорта идёт через `csvCell` (перенос `src/lib/team/csv.ts`
платформы LMS 2cd8a2b): строка, начинающаяся (после пробелов) с `=`, `+`, `-`, `@`, TAB, CR, получает
`'`; BOM, `;`, CRLF. В интерфейсе значения выводятся только как текст React (без
`dangerouslySetInnerHTML`); ссылки из строк — только `http(s)` (D-051).

### 3.7. Ресурсы процесса

Один разбор одновременно на процесс (семафор в `readSpreadsheet`, занято → 429 `busy`) и
`rateLimit('import-upload:<userId>', 20, 10 мин)`. Бюджет: 20 000 строк × 12 колонок ≤ 3 с и
≤ 300 МБ пика (у `app` `--max-old-space-size=1024`). Если замер на синтетике хуже — сказать
architect (вариант: `worker_threads`), не ослаблять пределы.

## 4. Профиль и настройки (`domain/import/settings.ts`)

- Раздел пространства `import` (CONFIG §6.13) читается из `getActiveConfig()` — уже проверенным схемой
  ConfigV1; своей схемы Zod и подмены настроек для тестов (`overrideImportContextForTests`) больше нет:
  интеграционные тесты пишут настоящую ревизию со слотами (D-191). Профиль = `imports.ImportProfile` +
  `label`, `kind` (`clients`; `bookings` — C4b, отдельным ключом схемы), `fieldTargets` (поле импорта →
  поле клиента или карточки: у ЦРП `head → client.head_name`, `activity → client.oked`,
  `niche → client.niche_other`; поле `pii: person` отбрасывается, если источнику импорта имена запрещены).
- Слоты `row_ranges` — `import.profiles[].ownerSlots` (`{label, ranges}`) **настройки установки**, не
  пресета (D-191): сопровождение задаёт их `crmctl config set` по списку РОП, ярлык нейтральный (цвет,
  блок), не ФИО. В ядро уходят как `OperatorSlot { label, name: label, color: '', ranges }`. Учётку
  слоту по-прежнему назначает РОП в предпросмотре (`ownerMap`); пресет ЦРП приходит с пустыми слотами
  — все строки «без владельца», пока слоты не заданы.
- `noteMarkers` — тоже ключ профиля в схеме; `headerScanRows`, `stateFields`, `personalIdForms` в схеме
  нет — у ядра свои значения по умолчанию, «личные» формы берутся из словаря (`idIsPersonal`).
- Карта итогов собирается так: `calling.outcomes[].importAliases` (CONFIG §6.5) → `valueMaps.outcome`,
  поверх — `valueMaps.outcome` профиля; `outcomeKinds` — из `calling.outcomes[]` (ключ → вид).
- Правила источника — `sources[]` с `kind: import` (ключ — `sourceKey`, по умолчанию `import`):
  `rejectRules`, `holdRules` → `buildPreview({ rules })`. ИП у ЦРП — в `holdRules` (D-052).
- Нормализаторы — `imports.createImportNormalizers(phone-правила установки, org.legalForms)`;
  «личные» формы — с `idIsPersonal` (переносит `names.legalFormsFromConfig`). Хэш ключей D-048 — `sha256`
  hex (`node:crypto`).
- **Редактора профиля в C4 нет** (D-116): РОП выбирает профиль из настроек; не сошлись заголовки —
  `header_not_found` с перечнем недостающих полей, профиль правит владелец через пресет или CLI.

## 5. Хранение (`imports`, `import_rows`)

| Что | Где | Правило |
|---|---|---|
| Загрузка | `imports`: `status='preview'`, `file_sha256`, `file_name`, `profile_key`, `created_by` | `report` — `ImportReportV1` (`types.ts`): только коды, id, числа, отпечаток. Имена сотрудников-ярлыков — хэшами (`ownerMapRef`) |
| Строки | `import_rows`: `row_no`, `import_key = rowKey:stateKey`, `parsed` = `ParsedRow` JSON, `issue` = худший код (`error` › `review`, иначе пусто) | вставка пачками по 500 через `unnest` |
| ИИН ИП | в `parsed` **нет**: при `orgIdPersonal` поля `orgId` и `fields.orgId` обнуляются, кладётся `orgIdHmac` (`CRM_IIN_HMAC_KEY`) | D-052; тест ищет 12 цифр ИИН во всех колонках |
| Срок | `purge` удаляет `import_rows` старше `import.rowsRetentionDays` (14) пачками по 5 000 | `imports` остаётся (счётчики); `apply`/`rows` после чистки → 410 `rows_expired` |
| Файл | не хранится | повтор = новая загрузка |

`client_id` в `import_rows` проставляется при применении (одним `UPDATE … FROM unnest`).

## 6. Предпросмотр (`domain/import/{load,preview}.ts`)

### 6.1. Что подгружается (только пространство `actor.spaceId`)

| Вход `buildPreview` | Запрос (`repo.ts`) |
|---|---|
| `rows` | `import_rows.parsed` по `row_no`; ИП: `orgId := 'iin:' + orgIdHmac` (дедуп по HMAC, сырой ИИН в память не возвращается) |
| `known` | кандидаты, а не вся база: не слитые и не обезличенные клиенты, у которых `org_id = ANY`, `iin_hmac = ANY`, номер `client_phones.digits = ANY` (рабочие и заглушки строк) или `name_norm = ANY`; `headNorm` — `normalizePerson` поля `fieldTargets.head`; ИП: `orgId = 'iin:' + iin_hmac` |
| `stopList` | `SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY($hmacs)` по всем рабочим номерам строк; `hash` = HMAC `CRM_PHONE_HMAC_KEY` |
| `prior` | §8 |
| `ownerMap` | из запроса; каждый `userId` — активный участник раздачи пространства (`memberships`, роль из `distribution.participantRoles`, `users.status = 'active'`), иначе 400 `bad_owner` |
| `bookings` | C4: пусто; C4b подставит индекс записей |

### 6.2. Отпечаток (D-113)

`imports.previewFingerprint(input, sha256)` — **новая чистая функция ядра (C4-core)**: sha256
канонического JSON `{ v: 1, buildId, configRev: {global, space}, importId, fileSha256, profileKey,
snapshotDay, ownerMap (ключи по порядку), rows: [[rowNo, action, hold, ownerUserId, matchId,
pairs (id+reason по порядку), outcomeKey, agreedWithoutBooking, stoppedPhones], …] }`.
`buildId` — `CRM_BUILD_ID` окружения или `'dev'`. Изменилось что угодно из этого (другая сборка,
правка настроек, новый клиент из приёма совпал со строкой, другая карта) — отпечаток другой.

### 6.3. Ответ и запись

`PreviewSummary` (`types.ts`): счётчики по действиям и задержкам, «каждому оператору N» (с именами
для экрана), без владельца, несопоставленные ярлыки, пересечения правил (`imports.ruleOverlaps`),
`heldWithWorkingOutcome`, `blockers`. В `imports.report.preview` пишется `PreviewStamp` (без имён).
Блокеры «Применить»: `unmapped_slots`, `no_owner_slots` (профиль `row_ranges` без слотов в настройках
установки — все строки ушли бы без владельца, рабочие итоги отложились бы; сначала слоты, D-191, D-222),
`rows_expired`, `config_changed` (ревизии настроек импорта, дедупа, источников или номеров ≠
`report.input.parseConfigRev` → загрузить заново), `already_applied`, `failed`. Предпросмотр
бизнес-таблицы не меняет. «Каждому оператору N» считает и строки `update_state`, которым повтор назначает
владельца (§8).

Список строк (`GET …/rows`) пересчитывает предпросмотр с картой из `ownerMapRef` (≤ 2 с на 20 000
строк; кэш не нужен) и отдаёт страницу `ImportRowView` по фильтру `RowFilter`.

## 7. Применение (`domain/import/apply.ts`)

### 7.1. Порядок (одна транзакция `db.tx`)

1. `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '120s'`.
2. `SELECT pg_try_advisory_xact_lock(${IMPORT_APPLY_LOCK_KEY})` → `false` → 409 `busy` (второй РОП,
   двойное нажатие, ночная дозагрузка CLI). Один импорт на установку одновременно.
3. `SELECT … FROM imports WHERE id = $1 AND space_id = $space FOR UPDATE` → нет → 404.
   `applied` → вернуть `report.apply` с `alreadyApplied: true` (ничего не пишем). `failed` → 409.
4. Блокеры §6.3 → 409 `blocked`.
5. `pg_advisory_xact_lock(${INTAKE_LOCK_KEY})` (D-022: приём, «Предложить контакт», ручное создание
   ждут ≤ секунд).
6. Загрузка входов §6.1 **внутри транзакции**, `buildPreview`, отпечаток. Не совпал с запросом → 409
   `preview_stale` + свежая сводка; транзакция откатывается.
7. План записи по строкам (§7.2, §7.3), запись пачками по 500 строк: каждый вид строк — один
   `INSERT … SELECT * FROM unnest(${a}::text[], ${b}::bigint[], …)` (у драйвера нет `sql(obj)`).
8. `UPDATE import_rows SET client_id …`; `UPDATE imports SET status='applied', applied_at, report`.
9. `writeAudit({ action: 'import.apply', entity: 'import', entityId, spaceId, meta: { rows, written… } })`.

Любая ошибка — откат целиком; `imports` остаётся `preview`, повтор безопасен. Пометка `failed` —
только при ошибке данных, которую повтор не исправит (отдельной короткой транзакцией, код в
`report.error`). Повторная доставка того же запроса после успеха — шаг 3. Второй рубеж от дублей —
уникальные индексы: `calls.import_key`, `client_sources (source_key, external_id)`,
`client_phones (client_id, digits)`, `dup_pairs (a, b, reason)`, `tasks.source_key` (открытые) —
все вставки `ON CONFLICT DO NOTHING`.

Бюджет: 2 200 строк ≤ 10 с на стенде, 20 000 ≤ 60 с. Перед применением на бою — внеочередная копия
БД (`crmctl backup`, шаг в RUNBOOK; экран показывает напоминание): отката импорта нет (D-113).

### 7.2. Что пишет каждое действие

`occurredAt` = `snapshotDay` 18:00 по поясу установки, но не позже `now`. Автор звонков, событий,
`assign_log.actor_id` — РОП, нажавший «Применить» (`actor.userId`), у звонка `user_id = NULL`,
`via = 'import'` (D-067). `assign_log.run_id = importId` — так находятся все выдачи импорта.

| Действие | Запись |
|---|---|
| `invalid`, `duplicate_in_file`, `skip_same`, `rejected_rule`, `stop_list` | ничего (только счётчик) |
| `create` | `clients` (`source_kind='import'`, `source_key`, `name`, `name_norm`, `legal_form`, `org_id` или `iin_hmac` для ИП, `region`, `address`, `custom` по `fieldTargets`, `search_norm`) · `client_phones` (рабочие; первый мобильный — `is_primary`; заглушки не пишутся) · `client_sources` (`external_id = rowKey`, `import_id`) · `cards` (план §7.3; владелец — только если строка без задержки и с владельцем) · `assign_log` (`kind='import'`, `counts_to_cap=false`) при владельце · звонок и побочные эффекты §7.3 · `dup_pairs` (`a < b`; `row:N` → id созданного клиента) · `client_events`: `client.created` + `import.row` |
| `merge` | номера `ON CONFLICT DO NOTHING`; пустые колонки клиента дописываются (не перезаписываются); `client_sources` для `rowKey`; карточки в пространстве нет — создаётся `new` (без итога таблицы), есть — **не меняется**; `import.row` |
| `update_state` | один звонок `import_key = rowKey:stateKey` и новое состояние по §7.3 — `UPDATE cards … WHERE id = $1 AND touched_in_crm = false AND version = $v`; 0 строк → строка уходит в `kept_in_crm` (оператор успел тронуть); карточка без владельца и без `hold_reason` получает владельца строки, как при `create` (`owner_user_id`, `assigned_at`, `assign_log kind='import'`, D-222); `import.row` |
| `kept_in_crm` | карточка не меняется; `import.row` с `action: 'kept_in_crm'` (следующая загрузка того же — `skip_same`); строка в отчёте «на разбор РОП» |

Событие `import.row`: `client_events.kind='import.row'`, `ref_type='import'`, `ref_id=importId`,
`data = { importId, rowNo, rowKey, stateKey, action, outcomeKey }` и, где есть, `deferred`, `flags`, `hold`
(коды). Сырой текст ячеек — «Ответ», «Заметка» и прочих — в событие **не пишется** (D-221): оператор пишет
туда «перезвонить жене, Айгуль +7…», а лента живёт бессрочно и переживает обезличивание. Итог в ленте —
только код `outcomeKey`; исходный текст РОП видит в строках предпросмотра и отчёта (`ImportRowView.answerRaw`,
выгрузка CSV с аудитом), пока `import_rows` не удалены по сроку (§11). Дольше срока текст ячейки живёт
только в полях клиента и карточки, куда профиль его явно направил (`fieldTargets`, §4) — это данные профиля
под реестром ПДн полей. `rowKey` и `stateKey` — sha256 опознающих полей и колонок состояния, не текст.

Карточки, клиенты, номера, события — через функции C2 (`domain/clients`, `domain/cards`), если они
уже есть с пакетным вариантом; иначе SQL в `domain/import/repo.ts` (схема v1 разрешает импорту писать
эти таблицы) с теми же правилами `search_norm` и проверки полей (`buildFieldValidator`, D-051).
Задачи перезвона и «Уточнить договорённость» — только через `domain/tasks/auto.ts` (D-050, C5).

### 7.3. Состояние карточки из таблицы (`imports.planImportedCard`, D-115)

Новая чистая функция ядра (C4-core): вход — строка, решение предпросмотра, карточка (для
`update_state`), настройки повторов и возвратов, календарь, `occurredAt`, `now`; выход — поля
карточки, строка звонка или `null`, эффекты (задача, стоп-лист, нерабочий номер, событие ленты).

| Вид итога строки | Карточка | Звонок | Эффекты |
|---|---|---|---|
| пусто | `new` | нет | — |
| `no_answer` | `retry`, `attempts=1`, `next_call_at=now`; при `maxAttempts=1` — `written_off` | да | — |
| `bad_number` | один рабочий номер → номер `is_working=false`, `written_off` («Нет рабочего номера», № 7); несколько → `retry`, `next_call_at=now`, номера не трогаем, замечание `bad_number_ambiguous` | да | — |
| `callback` | `callback`, `next_call_at=now`, `attempts=0` (дата из заметки — подсказка, PROCESS 3.7) | да | задача-перезвон (D-050) |
| `agreed` | `calling.applyOutcome({ type: 'import_agreed', bookingId: null })` → `callback` сейчас (№ 30; векторы r30a–r30c) | из эффектов | задача `clarify_import` |
| `not_interested` | `not_interested`, `return_at = occurredAt + returnDays.not_interested` (null — без возврата), `closed_at` | да | — |
| `not_target` | `not_target`, `is_target='no'`, `closed_at` | да | — |
| `do_not_call` | `do_not_call`, `closed_at` | да | рабочие номера → `stop_list` (`source='import'`); номер есть у другого клиента → не в стоп-лист, задача `stoplist_confirm` РОП (D-021) |

Общее: `lpr` из колонки (пусто ≠ «нет»); `is_target='yes'` из «Целевой»; «Не целевой» без итога
`not_target` не ставится (D-036) — замечание; счётчики `calls_total`, `connects_total`,
`no_answer_total`, `first/last_connect_at`, `last_touch_at`, `last_outcome_*` — как в calling;
`touched_in_crm` импорт не ставит никогда; `version + 1`.

**Задержанные (`hold`) и без владельца строки с рабочим итогом** (`retry`, `callback`, `agreed`):
карточка `new` без владельца с `hold_reason`, звонка нет, итог — в событии `import.row` и в ленте
(«в таблице: …»). Иначе карточка рабочего состояния осталась бы без владельца (D-066) или ИП ушёл бы
в обзвон до ответа юриста. Закрывающие итоги (`not_interested`, `not_target`, `do_not_call`,
`written_off`) применяются и у задержанных: «Полный отказ» обязан попасть в стоп-лист. Сколько таких
строк — `heldWithWorkingOutcome` в предпросмотре (вопрос владельцу — В-ИМП-1 ниже).

## 8. Повторный импорт (PROCESS 12.14, D-114)

`prior` для `buildPreview` (только пространство импорта):

```sql
SELECT cs.external_id AS row_key, c.touched_in_crm, c.owner_user_id, c.hold_reason, ev.state_key, ev.deferred
  FROM client_sources cs JOIN cards c ON c.client_id = cs.client_id AND c.space_id = $space
  JOIN LATERAL (SELECT e.data->>'stateKey' AS state_key, coalesce(e.data->>'deferred', '') = 'true' AS deferred
                  FROM client_events e
                 WHERE e.client_id = cs.client_id AND e.space_id = $space AND e.kind = 'import.row'
                   AND e.data->>'rowKey' = cs.external_id
                 ORDER BY e.at DESC, e.id DESC LIMIT 1) ev ON ev.state_key IS NOT NULL
 WHERE cs.source_key = $sourceKey AND cs.external_id = ANY($rowKeys)
```

**Отложенный итог — не повтор (D-222).** Если последнее применение строки отложило рабочий итог
(`deferred`, §7.3), карточка не задержана (`hold_reason = ''`), её не трогали в CRM, а владелец у неё есть
или находится по слотам/колонке (`assigned` или `unmapped` — тогда блокер `unmapped_slots`), то та же
пара ключей даёт `update_state`, а не `skip_same` (`PriorImportRow.deferredResumable`, считает
`load.ts`). Владельца такой и любой другой строке `update_state` по карточке без владельца и без задержки
назначает `load.ts` после `buildPreview` и до отпечатка — тем же `resolveOwner`, что у `create`. Так
загрузка до настройки слотов (или строка вне диапазонов) не теряет «Перезвонить» навсегда: после слотов
тот же файл применит владельцев и итоги, а следующий повтор снова даст `skip_same`. Задержанная строка
(`dup_pair`, `import_conflict`, `no_working_phone`, `rule`) ждёт разбора РОП и при повторе не трогается.

Применение пишет `client_sources` и `import.row` для каждой строки `create`, `merge`, `update_state`,
`kept_in_crm` (и у задержанных). Нет карточки в этом пространстве или события — строки нет в `prior`:
дедуп найдёт клиента → `merge`. `import_rows` для `prior` не
используются: они живут 14 дней. Слияние клиентов (12.20) переносит `client_sources`, лента читается
по цепочке `merged_into_id` (D-068) — запрос берёт `cs.client_id` выжившего.

Сценарии теста (README фикстур): тот же файл → все `skip_same`, ни одной новой строки ни в одной
таблице; правка «Ответа» одной строки → один звонок и новое состояние; карточку тронули в CRM →
`kept_in_crm`, звонка нет; повтор той же правленой загрузки → `skip_same`.

## 9. «Подтвержден» и профиль «Записи» (C4b)

В C4: `agreed` без записи → № 30 через `import_agreed` (`bookingId: null`), счётчик
`agreedWithoutBooking`. Точка расширения для C4b: `ImportProfileSetting.kind = 'bookings'` и вход
`bookings` предпросмотра; загрузка, строки, отпечаток, блокировка и транзакция — общие. C4b
(architect 25.10) решает: мероприятие по дате, запись `via='import'`, `bookings.import_key`, переход
`callback → agreed` и закрытие `clarify_import`.

## 10. Права, флаг, аудит, изоляция

- Все маршруты — `route({ perm: 'import.run', target })` P4a; страницы — `page()`. В пресетах
  `import.run` есть только у РОП (охват `space`). Администратор без роли — 403/404 (AGENTS.md),
  директор — нет права (403), «только чтение» и лицензия — 423 на мутации (не D-054).
- Импорт — объект пространства: каждый запрос к `imports` с `space_id = actor.spaceId`; чужой id → 404
  тем же телом.
- `FEATURE_IMPORT` (D-116): выключен → 404 на всех маршрутах импорта и пункт меню скрыт. Стенд — вкл,
  бой — вкл 26.10 после изоляции (гейт 3, п. 4).
- Аудит (`AUDIT_ACTIONS` + сущность `import`): `import.upload` (`{ importId, rows, kind }`),
  `import.apply` (`{ importId, fingerprint, written }`), `import.export` (`{ importId, filter, rows }`).
  Без имени файла, имён и номеров.
- Манифест `tests/isolation/manifest/import.ts`: все маршруты и обе страницы; id вида `import`.

## 11. Очистка

`purgeExpiredImportRows(system, now)` в `domain/import/purge.ts`: `DELETE FROM import_rows WHERE id
IN (SELECT id … WHERE created_at < $cutoff LIMIT 5000)` в цикле. Вызывает задача `purge` (P7,
03:30). `DELETE` на `import_rows` у `crm_app` есть (grants).

## 12. Файлы для builder

| Файл | Что | Задача |
|---|---|---|
| `src/server/platform/files/{body,sniff,zip,ooxml,csv,csvExport}.ts`, `xlsx/{workbook,sheet,styles,dates}.ts`, `index.ts` | §3 по сигнатурам `index.ts` | C4-files |
| `packages/core/src/import/csv.ts` | разделитель по 10 строкам (§3.5) | C4-core |
| `packages/core/src/import/cardPlan.ts` | `planImportedCard` (§7.3) | C4-core |
| `packages/core/src/import/fingerprint.ts` | `previewFingerprint` (§6.2) | C4-core |
| `src/server/domain/import/settings.ts` | Zod раздела, сборка профиля (§4) | C4-domain |
| `src/server/domain/import/repo.ts` | весь SQL: imports, import_rows, кандидаты, prior, стоп-лист, пакетные вставки, purge | C4-domain |
| `src/server/domain/import/{load,preview,apply,rows,purge,service}.ts` | §6–§8, §11; `service.ts` реализует `ImportService` | C4-domain |
| `src/app/api/import/**/route.ts` | §13 | C4-ui |
| `src/app/(mgr)/import/page.tsx`, `src/app/(mgr)/import/[id]/page.tsx` + клиентские компоненты рядом | §14 | C4-ui |
| `messages/ru/import.json` | тексты, коды ошибок файла и импорта, фильтры | C4-ui |
| `tests/isolation/manifest/import.ts` | манифест | C4-ui |

## 13. API (`src/app/api/import/`)

| Маршрут | Тело → ответ |
|---|---|
| `GET /api/import` | → `{ items: ImportListItem[] }` (последние 50) |
| `POST /api/import/uploads?profile&sheet&snapshotDay` | сырое тело + `X-File-Name` → 201 `UploadResult` · 413 `too_large` · 415 `bad_type`/`legacy_xls`/`macro`/`unsupported_encoding` · 422 `corrupt`/`zip_limits`/`xml_doctype`/`too_many_rows`/`header_not_found`/`sheet_required {sheets}`/`sheet_not_found` · 400 `bad_profile` · 429 `busy` |
| `GET /api/import/[id]` | → `ImportDetails` · 404 |
| `POST /api/import/[id]/preview` | `{ ownerMap }` → `PreviewSummary` · 400 `bad_owner` · 404 · 410 |
| `GET /api/import/[id]/rows?filter&offset&limit` | → `{ rows: ImportRowView[], total }` · 404 · 410 |
| `GET /api/import/[id]/rows.csv?filter` | → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="import-rows.csv"` (имя без данных) · аудит `import.export` |
| `POST /api/import/[id]/apply` | `{ fingerprint, ownerMap }` → 200 `ApplyResult` · 409 `busy`/`preview_stale {summary}`/`blocked {blockers}` · 410 · 404 |

Тела — Zod `.strict()`: `ownerMap` ≤ 200 ключей, ярлык ≤ 200 символов, `fingerprint` — 64 hex,
`snapshotDay` — `YYYY-MM-DD` не позже сегодня, `limit` ≤ 200. Ответы `no-store` (обёртка).

## 14. Страницы (оболочка менеджера, ноутбук)

- `/import`: список загрузок (статус, строк, кто, когда, «строки удалены»); форма: профиль, файл,
  лист (появляется после `sheet_required`), дата снимка (по умолчанию сегодня); прогресс; ошибки по
  кодам. Повтор файла — плашка «этот файл уже применён <дата>, предпросмотр покажет изменения».
- `/import/[id]`: (1) карта владельцев — ярлык → выбор сотрудника, предупреждение о пересечениях;
  (2) плитки: новых, дублей, обновится, оставлено как в CRM, в стоп-листе, отклонено правилом,
  задержано (по причинам), без владельца, на разбор, «Подтвержден» без записи, ошибки;
  (3) таблица «каждому оператору N»; (4) строки по фильтру с номером строки таблицы, выгрузка CSV;
  (5) «Применить» — диалог с итогом и напоминанием о копии; 409 `preview_stale` — «данные изменились,
  проверьте предпросмотр» и новая сводка; (6) после применения — что записано.
- Тексты — `messages/ru/import.json`; подписи итогов, ролей и мероприятий — из `label` настроек.

## 15. Тесты

**Unit** (`tests/unit/files/*.test.ts`, `packages/core/src/import/*.test.ts`); фикстуры XLSX
собирает помощник `tests/helpers/xlsx.ts` (свой ZIP-писатель на `deflateRawSync`, ~80 строк), бомбы —
им же с маленькими пределами в тесте:

- zip: часть с ложным малым размером, распаковывающаяся в 50 МБ → `corrupt` и память < 100 МБ;
  записей > предела; ZIP64; `../x`, `/x`; каталог за пределами файла; обрезанный файл.
- sniff: XLSX ок; XLSM и `vbaProject.bin` → `macro`; DOCX → `bad_type`; OLE2 → `legacy_xls`; PDF, PNG,
  NUL → `bad_type`; UTF-16 BOM → `unsupported_encoding`; CSV UTF-8 с BOM и без, cp1251.
- xlsx: общие строки и `<r>`; `inlineStr`; число 77091234567 без потери; даты (14, `dd.mm.yyyy`,
  `date1904`); пропуск строк (`r=2`, затем `r=5` → индексы 1 и 4); колонка `AA`; колонка 65 →
  `droppedColumns`; `r` больше предела → `too_many_rows`; DOCTYPE и ENTITY → `xml_doctype`; формула
  с `<v>` и без; два листа → `sheet_required`, выбор по имени и номеру; путь листа из rels; Strict-namespace.
- csv-разделитель: баннер + `;`; csvCell: `=1+1`, `+7…`, `-`, `@`, TAB, CR, пробел перед `=`,
  кавычки, `;`, перевод строки.
- body: `Content-Length` больше предела → 413 без чтения; поток больше предела → отмена; пусто.
- `planImportedCard`: вектор на каждую строку таблицы §7.3, задержанный с рабочим и с закрывающим
  итогом, `update_state` (счётчики накапливаются), `agreed` = r30a.
- `previewFingerprint`: порядок ключей карты не важен; меняется от `buildId`, ревизии, карты, решения
  одной строки.

**Интеграционные** (`tests/integration/import/*.test.ts`, Postgres 16, `TEST_DATABASE_URL`):

- загрузка синтетики `crp-main` (генератор `imports.syntheticSheets`): строки в `import_rows`; у ИП
  нет 12 цифр ИИН ни в `parsed`, ни в `report`; в `report` нет номеров (регэксп ≥ 10 цифр) и названий;
- предпросмотр: «каждому оператору N», спорные пары по общему номеру, пересечение диапазонов →
  `import_conflict`, ИП → `rule`;
- применение: число клиентов, карточек, звонков, `assign_log(kind='import')`; повтор `apply` того же
  импорта → `alreadyApplied`, счётчики таблиц равны; новая загрузка того же файла → 0 изменений во
  всех таблицах (снимок `count(*)`); правка итога → ровно один новый звонок; карточку тронули →
  `kept_in_crm` и без звонка;
- отпечаток: другой `ownerMap` или новый совпавший клиент между предпросмотром и применением → 409, ни
  одной записи;
- параллель: два `apply` двумя соединениями → один 409 `busy`; приём ждёт блокировку и не создаёт дубль;
- «Подтвержден» → `callback`, задача `clarify_import`; «Полный отказ» → HMAC в `stop_list`, общий номер
  → задача `stoplist_confirm`;
- purge: строки старше срока удалены, `apply` → 410; аудит `import.apply` без ПДн в `meta`;
- 2 200 строк применяются ≤ 10 с (порог теста 30 с).

**Изоляция**: оператор → 403 на разделе и 404 на `/api/import/[id]`; администратор без роли — так же;
директор — 403; РОП другого пространства (синтетический пресет) — 404. **E2E**
(`tests/e2e/base-import.spec.ts`): РОП загружает CSV → сопоставляет слоты → предпросмотр → применяет →
оператор видит свои карточки в очереди.

## 16. Задачи и уровни

| № | Задача | Ур. | Кто | Зависит от |
|---|---|---|---|---|
| C4-files | `platform/files/**` по §3, перенос zip/ooxml/csvCell из LMS, unit §15 | T1 | builder | `saxes@6.0.0` в package.json (координатор) |
| C4-core | разделитель CSV, `planImportedCard`, `previewFingerprint` + тесты | T1 | builder | — |
| C4-domain | settings, repo, load, preview, apply, rows, purge, service; интеграционные §15 | T2→T1 | builder → reviewer | C4-files, C4-core, P4a, P5, C2, C5 (`tasks/auto.ts`), ключи блокировок, HMAC |
| C4-ui | маршруты, страницы, `messages/ru/import.json`, манифест, e2e | T1 | builder | C4-domain |
| C4-mech | строки аудита, `'import'` в `AuditEntity` | T0 | mechanic | — |
| C4-review | ревью безопасности всего C4 (загрузка файлов, ПДн, блокировки) | T2 | reviewer | всё выше |

## 17. Нужно от других потоков (через координатора)

1. **package.json** (координатор): `"saxes": "6.0.0"` в `dependencies` (ISC, одна зависимость
   `xmlchars`, без нативных модулей).
2. **platform**: в `src/server/platform/db/locks.ts` — `IMPORT_APPLY_LOCK_KEY = 72_026_102_011` и общий
   `INTAKE_LOCK_KEY` (D-022), если C3 ещё не завёл; флаг `'IMPORT'` в `FEATURES`; HMAC-помощники
   `phoneHmac`/`iinHmac` (`CRM_PHONE_HMAC_KEY`, `CRM_IIN_HMAC_KEY`, в production без ключа — отказ),
   общие с C3 и K2; `fieldTargets` и профиль «Таблицы операторов» в пресете ЦРП (CONFIG §6.13) — сделано
   (D-191), слоты задаёт установка.
3. **ops**: `ENV CRM_BUILD_ID=${BUILD_ID}` в финальном слое `Dockerfile` (отпечаток «той же версии»);
   строка RUNBOOK «копия перед применением импорта»; `FEATURE_IMPORT=1` в env стенда.
4. **calling**: `domain/tasks/auto.ts` (C5) — создать перезвон и `clarify_import` в чужой транзакции;
   функции C2 для пакетного создания клиента и карточки, если будут.
5. **P7**: вызвать `purgeExpiredImportRows` в задаче `purge`.

### Вопросы владельцу

- **В-ИМП-1.** Строки, которые импорт задерживает (ИП до ответа юриста, общий номер, пересечение
  диапазонов, вне диапазонов) и где оператор уже поставил «Не берёт», «Перезвонить» или «Подтвержден»:
  ставить их «новыми» без владельца, а итог показывать в ленте карточки (**рекомендуем**: ИП не уходит в
  обзвон до юриста, не бывает карточки в работе без хозяина), или оставлять у оператора из диапазона с
  его итогом? Число таких строк предпросмотр покажет 26.10.
