# Импорт «Записи» — дизайн C4b для builder

Нормативно для C4b: решение D-324 (`docs/DECISIONS.md`, «предложено»), опирается на D-048, D-113, D-114,
D-115, D-116, D-191, D-221, D-222 (импорт), D-042, D-131…D-134 (запись), D-050, D-066, D-251 (карточка и
блокировки), D-052 (ИИН), D-017 (изоляция). Процесс: PROCESS 3.5 № 9 и № 30, 3.6, 3.7, 12.14, 12.39.
Общая часть импорта (загрузка, `import_rows`, отпечаток, блокировка импорта, очистка) — `docs/import-design.md`;
здесь только то, чем профиль «Записи» отличается.

**Миграций нет.** Всё ложится на схему v1: `bookings.via = 'import'`, `bookings.import_key` (уникальный индекс
`bookings_import_uq`), `bookings.booked_by_user_id` (NULL — автор неизвестен), `booking_history.action` без
закрытого списка, `assign_log.kind = 'import'`, `tasks.source = 'clarify_import'`, `client_events.kind = 'import.row'`.

## 1. Что делаем и чего нет

| Есть в C4b | Нет в C4b (почему) |
|---|---|
| строка таблицы записей → клиент (БИН/ИИН или номер) → групповое мероприятие по дате, виду и (если есть) времени → запись `registered`, `via='import'`, автор из колонки оператора | индивидуальные записи (консультация): в таблице нет времени слота и направления, угадывать нельзя — строка `unsupported_type`, РОП вносит мастером (В-ИМПЗ-2) |
| карточка `new`/`retry`/`callback` → `agreed` через ядро (`import_agreed` с `bookingId`, № 30 r30c), сделка «Записан», задача «Уточнить договорённость» закрывается | создание мероприятий из таблицы: нет мероприятия — строка в отчёте, РОП заводит его в «Мероприятиях» и загружает файл ещё раз |
| предпросмотр той же версией, отчёт по группам «клиент не найден / нет мероприятия / сотрудник не найден / дубль записи / на разбор» | прошедшие записи (дата раньше сегодняшней или мероприятие сегодня уже закончилось): история явки неизвестна, сверка явки создала бы ложные задачи (В-ИМПЗ-1) |
| повтор того же файла и дозагрузка изменений по ключам D-048 | отмена записи, если строку удалили из таблицы: файл — не полный снимок, отсутствие строки ничего не значит |
| автор: подсказка по номеру или ФИО сотрудника, карту утверждает РОП | перенос записи по изменённой дате: только «на разбор», переносит РОП (§6) |

## 2. Решения D-324 (кратко)

| № | Что |
|---|---|
| 1 | Профиль `kind: 'bookings'` — необязательные ключи профиля ConfigV1 (как D-191); отдельный разбор и предпросмотр в ядре, общие загрузка, строки, блокировки, транзакция |
| 2 | Ключ строки — опознающие поля клиента + вид + дата + время, **без автора**; ключ состояния — автор. `bookings.import_key = 'bk:' + sha256(spaceId ␟ rowKey)`; прошлое состояние — последняя `booking_history` с `action='import'` этой записи |
| 3 | Клиент ищется только среди клиентов **с карточкой в пространстве** РОП: чужое = несуществующее. БИН/ИИН-HMAC → номер → номер + название; неоднозначно — на разбор, не угадываем |
| 4 | Запись — через `createBooking(…, { tx, imported })` (B2, одна семантика мест, сделки, истории); переход карточки — ядро `import_agreed` с системным исполнителем ядра → `persistTransition` |
| 5 | Порядок блокировок D-251: импорт → приём → карточки (по id) → мероприятия (по id) → записи клиентов (по id), **до** пересчёта предпросмотра в транзакции |
| 6 | Автор: РОП утверждает карту «ярлык → сотрудник или „автор неизвестен“» (`authorMap`); несопоставленный ярлык — блокер `unmapped_authors` |
| 7 | Карточка тронута в CRM — записи нет (`kept_in_crm`); закрыта — записи нет (`state_conflict`); задержана или без владельца — запись есть, карточка не меняется, строка на разбор |
| 8 | Права: `import.run` + `booking.create` с охватом `space`; флаг `FEATURE_IMPORT_BOOKINGS` поверх `FEATURE_IMPORT` |

Отвергнутые варианты — в D-324.

## 3. Профиль в настройках (`packages/core/src/config/schema/v1.ts`, `integrity.ts`; зона platform)

Новые **необязательные** ключи `import.profiles[]` (отсутствие = профиль таблиц клиентов, ревизии до C4b верны
без миграции настроек — правило D-191/D-060 до первого выпуска):

| Ключ | Тип | Смысл |
|---|---|---|
| `kind` | `'clients' \| 'bookings'`, необязательный | нет = `clients` |
| `columns` (как было) | заголовок → поле | для `bookings` поля: `name`, `legalForm`, `phones`, `orgId`, `eventType`, `eventDate`, `eventTime`, `operator`; прочие игнорируются |
| `valueMaps.eventType` | `{<значение ячейки>: <booking.eventTypes[].key>}`, необязательный | регистр и пробелы не важны, ё = е |
| `defaultEventTypeKey` | `Key`, необязательный | вид, если колонки вида нет или ячейка пуста |
| `maxRows` | int 1…5 000, необязательный | предел строк профиля «Записи», по умолчанию 2 000 (применение идёт через `createBooking` построчно, §8.3) |

Проверка набора (`integrity.ts`) для `kind = 'bookings'`: `ownerBy = 'column'`; `ownerSlots`, `fieldTargets`,
`noteMarkers` пусты; среди полей есть `eventDate` и хотя бы одно из `phones`/`orgId`; есть `eventType` или
`defaultEventTypeKey`; каждое значение `valueMaps.eventType` и `defaultEventTypeKey` — ключ `booking.eventTypes[]`
того же пространства. `valueMaps.outcome/lpr/target` и `outcomePriority` для этого вида не используются (пустые).

`buildImportContext` (`domain/import/settings.ts`) отдаёт `kind` профиля как есть (сейчас там жёстко `'clients'`)
и для `bookings` — `eventTypeMap`, `defaultEventTypeKey`, `maxRows`, ключ итога вида `agreed` (первый не
архивный из `calling.outcomes[]`; нет — блокер `no_agreed_outcome`).

**Пресет клиента** (`presets/clients/<клиент>/preset.json`, зона platform, отдельный маленький PR): профиль
`bookings` с заголовками синтетической таблицы (`tests/fixtures/import/README.md`, раздел «Таблица записей»),
`valueMaps.eventType` по коротким и полным подписям групповых видов клиента, `defaultEventTypeKey` — основной
групповой вид. Заголовки реальной таблицы не подтверждены (PLAN §9 В-5): при расхождении сопровождение правит
профиль `crmctl config set`, код не меняется.

## 4. Разбор строк (ядро, `packages/core/src/import/bookingRows.ts`)

`imports.parseBookingSheet(table, profile, normalizers, hash, ctx: { spaceId, snapshotDay })` → тот же
`ParseSheetResult`-подобный результат с `ParsedBookingRow[]` (поиск заголовков, баннер, пустые строки — общий код
`parse.ts`). `import_rows.parsed` хранит `ParsedBookingRow` (pii, 14 дней), `import_rows.issue` — худший код.

```ts
interface ParsedBookingRow {
  rowNo: number;
  name: string; nameNorm: string; legalForm: string;
  /** БИН — 12 цифр; у «личной» формы — 'iin:<HMAC>' (redactPersonalId, D-052), сырых 12 цифр нет. */
  orgId: string | null; orgIdPersonal: boolean;
  workingPhones: string[]; stubPhones: string[];
  eventTypeKey: string | null;          // из valueMaps.eventType или defaultEventTypeKey
  eventTypeRaw: string;                 // для экрана РОП (живёт в import_rows до чистки)
  eventDate: string | null;             // 'YYYY-MM-DD'
  eventTime: string | null;             // 'HH:MM' или null
  authorLabel: string | null;           // ячейка «Оператор», подрезанная
  rowKey: string; stateKey: string;
  issues: RowIssue[];
}
```

- **Дата**: `YYYY-MM-DD` (так XLSX-ридер отдаёт ячейку с форматом даты), `YYYY-MM-DD ЧЧ:ММ` (ячейка «дата и
  время» — берётся дата), `ДД.ММ.ГГГГ`, `ДД.ММ.ГГ` (20ГГ), `ДД/ММ/ГГГГ`. Без года (`05.11`), текстом («в четверг»),
  несуществующая (31.11) или нулевой день эпохи Excel (`1899-12-30 …` — это время без даты) — `bad_date` (error), год
  не угадываем. Время: `Ч:ММ`/`ЧЧ:ММ`; XLSX-ячейка в формате времени приходит как `1899-12-30 ЧЧ:ММ` (1904 —
  `1904-01-01 …`, полночь — просто день эпохи), дата со временем — `YYYY-MM-DD ЧЧ:ММ`: берётся время. Иначе
  `bad_time` (error); пусто — `null`, но если в ячейке даты есть время, оно берётся оттуда.
- **Оператор**: пробелы схлопнуты, ярлык обрезается до `AUTHOR_LABEL_MAX` = 200 символов — столько принимает ключ
  `authorMap` в теле запроса; разных ярлыков у строк `create` больше `AUTHOR_MAP_MAX` = 200 — блокер
  `too_many_authors` (файл делится на части).
- **Вид**: ячейка без карты → `unknown_event_type` (error, не угадываем); вид с `behavior = 'individual'` —
  решение строки `unsupported_type` (§6), не ошибка разбора.
- Нет ни рабочего номера, ни `orgId` → `no_client_key` (error). Заглушки номеров (D-144) в поиск не идут.
- **Ключи (D-048)**: `rowKey = rowKeyOf(profileKey, {nameNorm, headNorm: '', workingPhones, stubPhones,
  legalForm}) + ␟ + eventTypeKey + ␟ + eventDate + ␟ + (eventTime ?? '')`, захэшированные тем же `KeyHashFn`;
  orgId входит в опознающие поля (`'iin:<HMAC>'` у ИП). `stateKey = stateKeyOf({operator}, ['operator'])`.
  `bookingImportKey(spaceId, rowKey) = 'bk:' + hash(spaceId ␟ rowKey)` — новая чистая функция: профили —
  объекты пространства, а индекс `bookings_import_uq` общий на установку.

## 5. Сопоставление (`domain/import/bookingLoad.ts`, SQL — только репозитории домена: `domain/import/bookingRepo.ts` для запросов профиля «Записи», `domain/import/repo.ts` — общие)

Все запросы — с `space_id = actor.spaceId`; карточки и записи — дополнительно со `scopeSql(viewer, 'card' |
'booking', 'booking.create')`, как в `createBooking`; мероприятия — с тем же охватом, что `findEvent` (`booking.read`). В транзакции применения те же выборки идут **после**
блокировок §8.2.

### 5.1. Клиенты-кандидаты

```sql
SELECT c.id, c.name_norm, c.org_id, c.iin_hmac,
       k.id AS card_id, k.state, k.owner_user_id, k.hold_reason, k.touched_in_crm, k.version,
       coalesce(array_agg(p.digits) FILTER (WHERE p.is_working), '{}') AS phones
  FROM clients c
  JOIN cards k ON k.client_id = c.id AND k.space_id = ${spaceId} AND ${scopeSql(v, 'card', 'booking.create')}
  LEFT JOIN client_phones p ON p.client_id = c.id
 WHERE c.merged_into_id IS NULL AND c.depersonalized_at IS NULL
   AND (c.org_id = ANY(${bins}) OR c.iin_hmac = ANY(${iinHmacs})
        OR c.id IN (SELECT client_id FROM client_phones WHERE digits = ANY(${digits}) AND is_working))
 GROUP BY c.id, k.id
```

Клиент без карточки в этом пространстве в выборку не попадает: для РОП его нет (`client_not_found`).
`imports.matchBookingClient(row, candidates)` (ядро):
1. `orgId` строки есть → кандидаты с тем же `org_id` (или `iin_hmac` для `'iin:'`): один → найден (`by: 'org'`);
   больше одного не бывает (уникальные индексы).
2. Иначе (или по `orgId` никого) → кандидаты с общим рабочим номером, у которых `org_id` пуст или равен
   `orgId` строки: один → найден (`by: 'phone'`); несколько → оставить с тем же `name_norm`: один → найден
   (`by: 'phone_name'`), иначе `client_ambiguous` (общий номер бухгалтера у разных ТОО — не склеиваем).
3. Никого → `client_not_found`.

### 5.1а. Спорные пары кандидатов (PROCESS 7.6, D-038, D-174, D-330)

Для кандидатов дочитываются пары `dup_pairs` со статусом `open|distinct` и карточки напарников в этом пространстве
(`bookingRepo.selectPairsOfClients`, `selectPartnerCards`). Без охвата РОП, как в раздаче: это проверка инварианта
«пара не делится», наружу уходят только коды замечаний строки. Ядро применяет к карточке без владельца то же
правило, что пул раздачи (`distribution.pairEffect`, одна функция на оба места), с учётом строк выше по файлу:
двойник, получивший владельца строкой выше, уже держит пару.

### 5.2. Мероприятия

```sql
SELECT e.id, e.event_type_key, e.event_date, e.start_time, e.starts_at, e.capacity, e.status,
       (SELECT count(*) FROM bookings b
         WHERE b.event_id = e.id AND b.status IN ('registered','confirmed','attended','no_show'))::int AS taken
  FROM events e
 WHERE e.space_id = ${spaceId} AND e.event_type_key = ANY(${groupTypes}) AND e.event_date = ANY(${dates})
```

`taken` — тот же счёт, что `countTaken` B2 (D-131). Выбор: `scheduled` того же вида и даты; есть время —
ещё и `start_time`. Ноль, но есть `cancelled` → `event_cancelled`; ноль → `no_event`; больше одного →
`event_ambiguous` (два мероприятия в день, а времени в строке нет).

### 5.3. Записи клиентов и прошлые импорты

```sql
-- занятые записи найденных клиентов: дубль и конфликт (§6)
SELECT b.id, b.client_id, b.event_id, b.event_type_key, b.status, b.starts_at, b.import_key
  FROM bookings b
 WHERE b.space_id = ${spaceId} AND b.client_id = ANY(${clientIds})
   AND b.status IN ('registered','confirmed','attended','no_show');

-- прошлое состояние строк (D-048): запись этого ключа в любом статусе + последний ключ состояния
SELECT b.import_key, b.id AS booking_id, b.client_id, h.state_key
  FROM bookings b
  LEFT JOIN LATERAL (SELECT bh.meta->>'stateKey' AS state_key FROM booking_history bh
                      WHERE bh.booking_id = b.id AND bh.action = 'import'
                      ORDER BY bh.created_at DESC, bh.id DESC LIMIT 1) h ON true
 WHERE b.space_id = ${spaceId} AND b.import_key = ANY(${bookingKeys})
```

История записи, а не лента клиента: она ключуется `booking_id`, переживает слияние клиентов и обезличивание
(в `meta` только коды и хэши).

### 5.4. Авторы

Ярлыки — различные `authorLabel` строк. Кандидаты — сотрудники с членством в пространстве (`memberships`, любой
статус: автор мог уже уволиться, заслуга остаётся, D-042) и `users.id, name, phone_digits, status`.
`imports.suggestAuthor(label, staff)` (ядро): в ярлыке 10–15 цифр → нормализованный номер = `phone_digits` →
`by: 'phone'`; иначе множество слов `normalizePerson(label)` = множеству слов имени ровно у одного сотрудника →
`by: 'name'`; иначе `none` или `ambiguous`. Подсказка только предзаполняет выбор: карту `authorMap` утверждает РОП
(`{<ярлык>: userId | null}`, `null` — «автор неизвестен»). Значение — участник пространства, иначе 400 `bad_author`.
Пустая ячейка оператора — тот же «автор неизвестен» без выбора.

## 6. Решение по строке (ядро, `imports.buildBookingPreview`)

Чистая функция: вход — строки, кандидаты §5, `authorMap`, участники раздачи (активные, роль из
`distribution.participantRoles`), `today` (местный день установки), `now`; выход — решение каждой строки и счётчики.
Проверки строго по порядку, первая сработавшая определяет действие:

| № | Условие | Действие | Группа отчёта | Пишется |
|---|---|---|---|---|
| 1 | ошибка разбора (`bad_date`, `bad_time`, `unknown_event_type`, `no_client_key`) | `invalid` | ошибки | — |
| 2 | `bookingImportKey` есть в БД, ключ состояния тот же | `skip_same` | дубль записи (уже загружено) | — |
| 3 | `bookingImportKey` есть, ключ состояния другой | `changed_in_file` | на разбор | `booking_history 'import'` с новым `stateKey` |
| 4 | вид индивидуальный | `unsupported_type` | нет мероприятия | — |
| 5 | клиент не найден / неоднозначен | `client_not_found` / `client_ambiguous` | клиент не найден | — |
| 6 | дата раньше `today` | `past_event` | нет мероприятия | — |
| 7 | мероприятия нет / отменено / несколько | `no_event` / `event_cancelled` / `event_ambiguous` | нет мероприятия | — |
| 7а | мероприятие уже закончилось (`starts_at + duration_min ≤ now`, в том числе сегодня); идущее загружается — гость попадает в список дежурного, явку отмечают на месте | `past_event` | нет мероприятия | — |
| 8 | та же пара (клиент, мероприятие) выше в файле | `duplicate_in_file` | дубль записи | — |
| 9 | у клиента уже занятая запись на это мероприятие | `booking_exists` | дубль записи | — |
| 10 | у клиента активная будущая запись того же вида на другое мероприятие (в БД или строкой выше) | `booking_conflict` | на разбор (перенос — решение РОП) | — |
| 11 | `touched_in_crm` | `kept_in_crm` | на разбор | — |
| 12 | карточка закрыта (`not_interested`, `not_target`, `written_off`, `do_not_call`) | `state_conflict` | на разбор | — |
| 13 | мест нет: `taken` + записи этого импорта на мероприятие выше по файлу ≥ `capacity` | `event_full` | нет мероприятия | — |
| 14 | иначе | `create` | — | запись, см. §8.3 |

У `create` — уточнения (входят в отпечаток):

| Карточка | `transition` | `ownerAfter` | Флаг строки |
|---|---|---|---|
| `new`/`retry`/`callback` с владельцем | `to_agreed` | владелец | — |
| `agreed`/`client` | `none` (уже договорились: ещё одна запись) | владелец | — |
| без владельца, `hold_reason = ''`, пару держит оператор напарника (§5.1а), он участник раздачи | `to_agreed` | оператор напарника (`assign_log kind='import'`), автор остаётся автором записи | `owner_from_pair` |
| без владельца, `hold_reason = ''`, пару держит оператор, который не участник раздачи | `none` | `null` | `card_unowned` (на разбор) |
| без владельца, `hold_reason = ''`, пара блокирована: напарник в «Не звонить» или задержан при `open`, либо напарники у разных операторов | `none` | `null` | `pair_hold` (на разбор) |
| без владельца, `hold_reason = ''`, пара не ограничивает (нет пар, напарник в пуле или закрыт), автор — участник раздачи | `to_agreed` | автор (`assign_log kind='import'`, D-222) | `owner_from_author` |
| уже переведена строкой `create` выше (тот же клиент на другой групповой вид) | `none` | владелец после той строки | — (или `card_unowned`) |
| без владельца, автор не участник или неизвестен | `none` | `null` | `card_unowned` (на разбор) |
| `hold_reason <> ''` (ИП до юриста, спорная пара) | `none` | без изменений | `card_held` (на разбор) |

Задержанная или безхозная карточка запись получает: гость должен попасть в список дежурного (PLAN, Ср 28.10), а
рабочего состояния без владельца не бывает (D-066) — поэтому карточка остаётся как есть, РОП разбирает.
Автор `null` при `create` — флаг `author_unknown` (группа «сотрудник не найден»); запись создаётся с
`booked_by_user_id = NULL`.

Состояние и владелец карточки берутся из снимка, пока строка `create` выше по файлу не изменила их: следующая строка
той же карточки видит «Договорились» и уже назначенного владельца — иначе применение второй раз переводило бы
карточку (ядро отклоняет `import_agreed` из `agreed`) и импорт застревал бы в `preview_stale`.

Повтор ключа — проверка № 2–3 **до** поиска клиента: запись, загруженная раньше, не создаётся заново, даже если
клиента потом слили, а запись отменили или перенесли в CRM.

## 7. Предпросмотр

- `POST /api/import/[id]/preview` для профиля `bookings`: тело `{ ownerMap: {}, authorMap }` → `BookingPreviewSummary`:
  счётчики по действиям и группам, «будет записей по мероприятиям» (дата, подпись вида, сколько + занято/мест),
  «перейдут в „Договорились“», «закроется задач „Уточнить договорённость“» (`callback` с открытой `clarify_import`),
  «останется открытых „Уточнить договорённость“ в пространстве» (одна `count(*)`), подсказки авторов
  (`label`, `suggestedUserId`, `by`, имя для экрана), блокеры.
- Блокеры «Применить»: общие (`rows_expired`, `config_changed`, `already_applied`, `failed`) +
  `unmapped_authors` (ярлык без решения РОП), `too_many_authors` (разных ярлыков у строк `create` больше 200),
  `no_agreed_outcome`, `nothing_to_apply` (ни одной строки `create`
  и `changed_in_file`).
- **Отпечаток** — `imports.bookingPreviewFingerprint` (ядро): sha256 канонического JSON `{ v: 1, kind: 'bookings',
  buildId, configRev, importId, fileSha256, profileKey, snapshotDay, today, authorMap (ключи по порядку), rows:
  [[rowNo, action, flags, clientId, cardId, eventId, authorUserId, transition, ownerAfter], …] }`. Новый клиент из
  приёма, запись из мастера, правка мест, смена владельца, другой день — другой отпечаток.
- `imports.report.preview` — `BookingsPreviewStamp` (`kind: 'bookings'`): отпечаток, ревизии, `authorMapRef`
  (sha256(normalizeLabel) первые 16 hex → userId | null), счётчики. Без имён, номеров, названий.
  `PreviewStamp` и `ApplyStamp` становятся объединениями по `kind`; отсутствие `kind` = профиль клиентов (старые
  отчёты читаются без миграции).

## 8. Применение (`domain/import/bookingApply.ts`)

### 8.1. Кто действует

Маршрут уже под `import.run`. Сервис для профиля `bookings` дополнительно требует `scopeOf(viewer,
'booking.create') === 'space'` и `scopeOf(viewer, 'card.assign') === 'space'`, иначе 403 — до загрузки строк.
В `apply` передаётся полный `Viewer` (сейчас `ImportActor` — его проекция; сигнатура сервиса расширяется).

### 8.2. Транзакция и блокировки (D-113 + D-251)

1. `db.tx`; `SET LOCAL lock_timeout = '5s'`, `statement_timeout = '120s'`.
2. `pg_try_advisory_xact_lock(IMPORT_APPLY_LOCK_KEY)` → `false` → 409 `busy`.
3. `imports … FOR UPDATE` (пространство) → нет → 404; `applied` → прежний итог; `failed` → 409.
4. Блокеры §7 → 409 `blocked`.
5. `pg_advisory_xact_lock(INTAKE_LOCK_KEY)` — приём не создаст клиента, совпадающего со строкой, посреди применения.
6. Чтение кандидатов §5.1 и напарников §5.1а (без блокировок) →
   `SELECT id FROM cards WHERE id = ANY(${cardIds ∪ partnerCardIds}) AND space_id = ${spaceId} AND (id = ANY(${partnerCardIds}) OR ${scopeSql(...)}) ORDER BY id FOR UPDATE` →
   `SELECT id FROM events WHERE id = ANY(${eventIds}) AND space_id = ${spaceId} ORDER BY id FOR UPDATE` →
   `SELECT id FROM bookings WHERE client_id = ANY(${clientIds}) AND space_id = ${spaceId} ORDER BY id FOR UPDATE`.
   Все карточки — раньше всех мероприятий, все мероприятия — раньше записей: мастер записи (карточка → мероприятие
   → записи клиента) ждёт, а не входит во взаимную блокировку.
7. Пересчёт §5–§6 уже под блокировками. Пересчёт увидел карточку (в том числе напарника пары), мероприятие или клиента, которых нет среди
   заблокированных в п. 6 (появились между чтением и блокировкой), → 409 `preview_stale`: следующий заход заблокирует
   их по порядку. Отпечаток ≠ запросу → 409 `preview_stale` + свежая сводка, откат.
8. Запись по строкам `create` в порядке файла (§8.3), затем `changed_in_file` (только история).
9. `UPDATE import_rows SET client_id`; `imports.status = 'applied'`, `report.apply` (`BookingApplyCounts`);
   аудит `import.apply` с `meta { importId, fingerprint, kind: 'bookings', written }`.

Любая ошибка (в том числе `BookingDomainError` из `createBooking` и отказ ядра) — откат целиком; сервис
отвечает 409 `preview_stale` со свежей сводкой (пересчёт в отдельной читающей транзакции). Под блокировками п. 6
это может случиться только при ошибке в коде. Бюджет: 500 строк ≤ 10 с на стенде, 2 000 ≤ 60 с.

### 8.3. Строка `create`

1. `ownerAfter` отличается от владельца карточки (`owner_from_author` или `owner_from_pair`) → `repo.assignImportedOwner(sql, cardId,
   version, userId, now)` (`UPDATE cards SET owner_user_id, assigned_at, version = version + 1 WHERE id = $1 AND
   version = $2 AND owner_user_id IS NULL AND hold_reason = ''`; 0 строк → ошибка, откат) + `assign_log`
   (`kind='import'`, `counts_to_cap=false`, `run_id = importId`, `actor_id` — РОП).
2. `createBooking(deps, viewer, { kind: 'group', requestId: newId(), clientId, eventId, contactId: null },
   { tx, imported: { importKey: bookingImportKey, bookedByUserId: author } })`: места, сделка `ensureOpen`
   («Записан»), `bookings.via='import'`, `responsible_user_id` = владелец карточки, история `created`, лента
   `booking.created`. Перенос (`resolveRepeatBooking → move`) здесь невозможен: № 10 §6 и блокировки п. 6.
   Результат `replayed` или `moved` → ошибка, откат.
3. `booking_history` `action='import'`, `meta { importId, rowNo, stateKey }` — прошлое состояние для повтора.
4. `transition = 'to_agreed'` → `lockCardScoped(tx, viewer, cardId, 'card.assign')` (карточка уже под
   блокировкой — повторный `FOR UPDATE` мгновенный) → `calling.applyOutcome({ event: { type: 'import_agreed',
   opId: newId(), outcomeKey: agreedKey, occurredAt, bookingId }, actor: { userId: null, kind: 'system', scope:
   'space' }, … })` — так же, как `cardPlan.ts` C4. Это значение исполнителя **ядра** (`import_agreed` — событие
   только системы), а не `SystemActor` доступа: он по-прежнему только в `scripts/**` и `src/server/jobs/**`, в базу
   пишет `viewer` РОП. Не `applied` → ошибка, откат; затем
   `persistTransition(tx, viewer, { ctx, before, result, at: now })`. Ядро (r30c): `agreed`, «Целевой: да»,
   `attempts = 0`, импортный звонок (`via='import'`, `user_id NULL`, D-067), `ensure_open` находит сделку из п. 2,
   выход из `callback` закрывает проекцию срока — в том числе `clarify_import` (D-050). `touched_in_crm` не ставится.
   `occurredAt` — дата снимка 18:00 по поясу установки, не позже `now` (как C4).
5. Лента: `client_events` `import.row` с `data { importId, rowNo, rowKey, stateKey, action: 'booking_created',
   bookingId, flags }` — только коды и ключи (D-221).

`createBooking` уже пропускает проверку состояния карточки и закрытие задач «записать» при `imported` — это
делает переход п. 4. Правок модуля записи не нужно.

## 9. Повтор и дозагрузка (D-048, PROCESS 12.14)

| Что в файле | Итог |
|---|---|
| тот же файл ещё раз (или та же строка в новом файле) | все строки — `skip_same`; ни одной новой строки ни в одной таблице, кроме `imports`/`import_rows` новой загрузки |
| новые строки дописаны в таблицу | только они — `create` |
| у строки сменился оператор | `changed_in_file`: запись в CRM не меняется (заслуга после загрузки — данные CRM, D-042), РОП видит строку на разбор; `booking_history 'import'` с новым ключом — следующий повтор даёт `skip_same` |
| у строки сменилась дата или вид | это другая строка (другой ключ): у клиента уже есть будущая запись того же вида → `booking_conflict`, переносит РОП мастером |
| строку удалили | ничего: файл — не полный снимок |
| запись из импорта отменили или перенесли в CRM | ключ остаётся у старой записи → `skip_same`, запись не воскресает |
| клиента не было, потом пришла таблица клиентов | та же строка при следующей загрузке находит клиента → `create` |

Повтор `apply` того же импорта — `alreadyApplied` (общий шаг 3). Второй рубеж — `bookings_import_uq` и
`bookings_group_uq`: нарушение — ошибка и откат, а не тихий пропуск.

## 10. Связь с профилем таблиц клиентов (№ 30)

- Профиль клиентов не меняется: вход `bookings` его предпросмотра остаётся пустым, «Подтвержден» всегда даёт
  № 30 — «Перезвон: сейчас» и задача «Уточнить договорённость» (`clarify_import`). Путь в `agreed` из таблиц —
  только профиль «Записи».
- Порядок пилота: таблицы операторов (С4) → таблица записей (C4b). Запись находит карточку в `callback` → № 30
  r30c → `agreed`, задача закрыта. Карточки «Подтвержден», которым запись не нашлась, остаются у владельца с
  задачей — экран предпросмотра показывает, сколько их останется.
- Обратный порядок допустим: строки «Записей» уйдут в «клиент не найден», повтор того же файла после таблиц
  клиентов их создаст (§9).
- Повторная загрузка таблицы клиентов по карточке, уже переведённой записью в `agreed`: `import_agreed` из `agreed`
  ядро отклоняет → импорт пишет звонок фактом (`stale`), как сейчас (`cardPlan.ts`); «Не целевой»/«Полный отказ»
  из таблицы закрывают карточку и отменяют будущие записи по общим правилам № 11–12.

## 11. Права, флаг, изоляция, ПДн

- Импортирует **РОП** (`import.run` + `booking.create` + `card.assign` с охватом `space`). Администратор — только
  если у него в пространстве роль РОП; без роли — 404 (D-116, AGENTS.md). Оператор, директор — 403.
- `FEATURE_IMPORT_BOOKINGS` (новый флаг, нужен и `FEATURE_IMPORT`): выключен — профиль `bookings` скрыт в списке,
  загрузка с ним — 400 `bad_profile`, предпросмотр и применение такого импорта — 404. Стенд — вкл; бой — вкл после
  приёмки 27.10 (PLAN, импорт «Записи» 27.10). На стенде Vercel загрузка закрыта (D-318).
- Чужое = несуществующее: импорт другого пространства — 404; клиент только с карточкой другого пространства —
  `client_not_found` (тот же код, что «нет такого»); мероприятия — только своего пространства.
- ПДн: таблица записей — названия, номера, БИН, имена операторов. Хранятся только в `import_rows.parsed` (14 дней).
  12 цифр «личной» формы — сразу HMAC (D-052). В `report`, `booking_history.meta`, `client_events`, аудите — только
  id, коды, числа и хэши; ярлыки авторов — `authorMapRef`. Имена сотрудников в подсказках уходят только РОП в
  ответе предпросмотра. CSV-выгрузка строк — через `csvCell` и аудит `import.export`, как C4.

## 12. API и экран (дельта к C4d §13–§14)

| Маршрут | Изменение |
|---|---|
| `POST /api/import/uploads?profile=<bookings>` | профиль `bookings` разрешён при флаге и правах §11; предел строк — `maxRows` профиля |
| `POST /api/import/[id]/preview` | `{ ownerMap: {}, authorMap: Record<string, string \| null> }` (Zod `.strict()`, ≤ 200 ключей) → `BookingPreviewSummary` · 400 `bad_author` |
| `GET /api/import/[id]/rows?filter` | фильтры по группам §6 и коду; `BookingRowView`: номер строки, название, дата, подпись вида, ярлык автора, код, ссылка на мероприятие или запись |
| `POST /api/import/[id]/apply` | `{ fingerprint, ownerMap: {}, authorMap }` → `ApplyResult` с `BookingApplyCounts` · 409 `busy`/`preview_stale`/`blocked` |

Экран `/import/[id]` для профиля `bookings` (ноутбук РОП): (1) карта авторов — ярлык → выбор сотрудника, подсказка
предзаполнена, пункт «Автор неизвестен»; (2) плитки групп (клиент не найден, нет мероприятия, сотрудник не найден,
дубль записи, на разбор, ошибки) и «будет записано»; (3) таблица «по мероприятиям»; (4) строки по фильтру;
(5) «Применить» с напоминанием о копии. Тексты — `messages/ru/import.json` (`bookings.*`), подписи видов и итогов —
из настроек; подпись истории записи `import` — в локали модуля записи.

## 13. Тесты

**Unit (ядро, `packages/core/src/import/*.test.ts`)**
- `parseBookingSheet`: даты всех форматов, `05.11` и `31.11` → `bad_date`; время; вид по карте, по умолчанию,
  неизвестный; ИП с 12 цифрами → в строке нет 12 цифр, `orgId` = `iin:…`; два номера в ячейке; нет ключа клиента.
- ключи: автор не меняет `rowKey` и меняет `stateKey`; пробелы и регистр автора не меняют `stateKey`;
  `bookingImportKey` разный для двух пространств.
- `matchBookingClient`: по БИН; по номеру; общий номер двух ТОО → по названию / `client_ambiguous`; номер клиента с
  другим БИН не совпадает.
- `buildBookingPreview`: вектор на каждую строку таблицы §6 и каждое уточнение `create`; порядок проверок (повтор
  раньше поиска клиента; `past_event` раньше `no_event`); места по порядку файла; дубль и конфликт со строкой выше.
- `suggestAuthor`: по номеру, по ФИО в другом порядке слов, два однофамильца → `ambiguous`.
- `bookingPreviewFingerprint`: порядок ключей карты не важен; меняется от автора, `today`, решения одной строки.
- схема и `integrity`: профиль `bookings` без `eventDate`, с вида-«консультацией» в `defaultEventTypeKey`, со слотами — ошибки.

**Интеграционные (`tests/integration/import/bookings-*.test.ts`, Postgres 16)** — настоящая ревизия настроек со
слотами и профилем `bookings` (D-191), синтетика генератора:
- поток: таблица клиентов → таблица записей → `bookings` с `via='import'`, `import_key`, автором по карте;
  карточки `agreed`, сделка на этапе «Записан», `clarify_import` закрыта, импортный звонок `user_id IS NULL`;
- повтор: новая загрузка того же файла → все `skip_same`, снимок `count(*)` по `bookings`, `booking_history`,
  `calls`, `deals`, `tasks`, `client_events`, `assign_log` не изменился; повтор `apply` → `alreadyApplied`;
- смена автора → `changed_in_file`, запись не изменилась; повтор той же загрузки → `skip_same`;
- запись из мастера на то же мероприятие → `booking_exists`; будущая запись того же вида → `booking_conflict`;
  карточка тронута → `kept_in_crm`; «Полный отказ» → `state_conflict`; ИП (задержан) → запись есть, карточка `new`;
  без владельца, автор — оператор → владелец, `assign_log kind='import'`; места кончились → `event_full`;
  отменённое и прошедшее мероприятие; клиент с карточкой только в другом пространстве → `client_not_found`;
- спорные пары (`bookings-pairs.test.ts`, D-330): `distinct` с напарником у оператора → владелец — он
  (`owner_from_pair`), автор записи прежний; `open` с «Не звонить» и два необработанных дубля → `pair_hold`, карточка
  без владельца; напарник сменил оператора между предпросмотром и применением → 409 `preview_stale`;
- отпечаток: запись из мастера между предпросмотром и применением → 409 `preview_stale`, ни одной записи;
- параллель: два `apply` → один `busy`; `createBooking` из мастера по карточке строки во время применения ждёт и не
  ловит взаимную блокировку (оба завершаются, итог согласован);
- ПДн: в `report`, `booking_history.meta`, `client_events.data`, `audit_log.meta` нет ≥ 10 цифр подряд и названий;
  в `import_rows.parsed` нет 12 цифр ИИН; 500 строк ≤ 30 с (порог теста).

**Изоляция** (`tests/isolation/manifest/import.ts` — маршруты те же, добавить случаи): оператор 403; администратор
без роли 404; директор 403; РОП другого пространства 404; роль с `import.run`, но без `booking.create` на
пространство (синтетический пресет) — 403 на предпросмотр и применение профиля `bookings`.

**E2E** (`tests/e2e/base-import-bookings.spec.ts`, размер ноутбука РОП + проверка дежурного на `pixel-7`): РОП
загружает CSV записей → подтверждает авторов → предпросмотр → применяет → гость виден в списке дежурного на
мероприятии; карточка у оператора в «Договорились».

**Фикстуры**: генератор `imports.syntheticSheets` получает в `meta` строки-дефекты таблицы записей (описание —
`tests/fixtures/import/README.md`, раздел «Таблица записей»); номера только `+7 709 …`, компании выдуманные.

## 14. Файлы и задачи

| № | Задача | Файлы | Ур. | Поток | Кто |
|---|---|---|---|---|---|
| C4b-cfg | ключи профиля `kind`, `valueMaps.eventType`, `defaultEventTypeKey`, `maxRows` + `integrity` + тесты схемы | `packages/core/src/config/schema/v1.ts`, `integrity.ts`, `tests/unit/config/**` | T1 | platform | builder |
| C4b-preset | профиль `bookings` в пресете клиента | `presets/clients/<клиент>/preset.json` | T0 | platform | mechanic (по §3) |
| C4b-flag | `'IMPORT_BOOKINGS'` в `FEATURES`, env стенда | `src/server/platform/flags.ts`, `docs/ops/**` | T0 | platform / ops | mechanic |
| C4b-core | `parseBookingSheet`, ключи, `matchBookingClient`, `suggestAuthor`, `buildBookingPreview`, отпечаток, генератор + unit | `packages/core/src/import/{bookingRows,bookingMatch,bookingPreview,bookingFingerprint,syntheticSheets}.ts` | T1 | base | builder |
| C4b-domain | settings (вид профиля), repo (SQL §5, блокировки §8.2, `assignImportedOwner`, история `import`), `bookingLoad`, `bookingApply`, ветка в `service`/`upload`/`preview`/`rows`, типы-объединения отчёта + интеграционные | `src/server/domain/import/**`, `tests/integration/import/bookings-*.test.ts` | T2→T1 | base | builder → reviewer |
| C4b-ui | Zod `authorMap`, экран карты авторов и плиток, `messages/ru/import.json` (`bookings.*`), изоляция, e2e | `src/app/api/import/**`, `src/app/(mgr)/import/**`, `tests/isolation/manifest/import.ts`, `tests/e2e/base-import-bookings.spec.ts` | T1 | base | builder |
| C4b-hist | подпись `booking_history.action = 'import'` в истории записи | `messages/ru/booking.json` | T0 | booking | mechanic (issue на поток) |
| C4b-review | ревью безопасности: загрузка, ПДн, блокировки, охваты | всё выше | T2 | — | reviewer |

Зависимости: C4b-core → C4b-domain → C4b-ui; C4b-cfg до C4b-domain; C4b-preset после C4b-cfg.

## 15. Вопросы владельцу

- **В-ИМПЗ-1.** Записи на мероприятия, которые уже прошли до загрузки: не загружать (**рекомендуем**: явка
  неизвестна, сверка явки поставила бы карточкам «Не пришёл» и задачи «Отметьте явку» по чужим старым данным) или
  загружать как «Пришёл» без проверки? Число таких строк покажет предпросмотр (`past_event`).
- **В-ИМПЗ-2.** Заявки на консультацию в таблице записей: вносить мастером вручную (**рекомендуем**: в таблице нет
  времени слота и направления, их немного) или расширить профиль колонками времени и направления после пилота?
- **В-ИМПЗ-3** (= PLAN §9 В-5). Заголовки реальной таблицы записей и есть ли в ней БИН и время. До ответа профиль
  в пресете — по синтетике; правка — `crmctl config set`, без кода (**рекомендуем** прислать только строку
  заголовков, без данных).
