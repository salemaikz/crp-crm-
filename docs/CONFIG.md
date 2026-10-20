# Настройки и пресеты

Статус: **итоговый дизайн architect от 20.10.2026, ред. 3 (21.10, P5: исполняемая схема и слияние — D-081…D-083)**. Ключи в этом файле
окончательные для схемы `ConfigV1`; `docs/PROCESS.md` §13 ссылается сюда.

Главное правило продукта: **код знает поведение, всё остальное — настройки**.
В коде нет слов «БР», «БК», «Астана», «40». Всё, что специфично для ЦРП, лежит
в пресете ЦРП.

---

## 1. Что где живёт

| Что | Где | Кто меняет | Пример |
|---|---|---|---|
| **Поведение** (закрытые списки) | код (`packages/core`) | только разработчик, новой версией | 9 состояний карточки, 7 видов итога, статусы записи, охваты прав |
| **Настройки установки** | БД, `config_revisions` (документ `ConfigV1`) | пресет при установке, затем UI или CLI | итоги и подписи, лимит, повторы, роли, поля, воронки, типы мероприятий |
| **Рабочие данные, похожие на настройки** | обычные таблицы | РОП или администратор в UI | серии мероприятий, консультанты и их график, команды, сотрудники и роли |
| **Окружение установки** | файл окружения на сервере (root, 0600) | при установке, `crmctl` | адрес БД, ключи шифрования и HMAC, флаги, VAPID |
| **Лицензия** | `license_state` + файл | владелец выдаёт, администратор загружает | срок, `features`, `seats` |
| **Интеграции** | `integrations`, `integration_secrets` | администратор в UI | провайдер телефонии и мессенджера, ключи API |

Бизнес-настройки никогда не лежат в окружении. Секреты никогда не лежат в
документе настроек.

---

## 2. Где хранятся настройки

- Два вида документов по одной Zod-схеме `ConfigV1`
  (`packages/core/src/config/schema/v1.ts`):
  - `global` — компания, календарь, номера, дедуп, источники, роли, тема,
    пространства;
  - по одному на пространство (`scope = space_id`) — итоги, повторы, очередь,
    раздача, воронки, причины, поля, мероприятия, напоминания, услуги, передачи,
    задачи, отчёты, уведомления, тревоги, импорт.
- Таблица `config_revisions(scope, rev, schema_version, doc, hash, source,
  preset_doc, author_id, created_at)`. `scope` — `global` или **id** пространства
  (в пресете и CLI пространство называется ключом, связь — таблица `spaces`).
  Текущая ревизия = максимальная `rev` в области среди совместимых (ниже).
  Номер новой ревизии — максимум по области среди **всех** версий схемы + 1.
  Ревизии не удаляются. `doc` — полный документ области, не дельта.
- `hash` — sha256 канонического JSON документа (ключи по алфавиту, без
  пробелов): jsonb не хранит порядок ключей (D-083).
- Любое изменение = новая ревизия целиком. Нет «половины настройки»: итог,
  его причины и обязательные поля меняются одной записью.
- Откат = новая ревизия с содержимым старой (`source='rollback'`).
- При применении пресета в ревизию пишется собранный пресет (`preset_doc`). Это
  база для будущего трёхстороннего слияния при обновлении пресета.
- Чтение: типизированные геттеры с кэшем в процессе. Геттер берёт последнюю
  ревизию области со `schema_version` не выше той, что знает эта версия
  продукта (D-060): после `crmctl rollback` прежняя версия читает свою
  ревизию, а не документ новой схемы. Совместимая ревизия старшей версии схемы,
  чем у документа (выкладка ещё не прогнала миграцию настроек), приводится
  миграцией в памяти, без записи. Процесс проверяет максимальную `rev` не
  чаще раза в 5 секунд, после собственной записи — сразу.
- Схема — `packages/core/src/config/schema/v1.ts`, проверка набора целиком —
  `validateConfigSet` (документы пространств ссылаются на роли и поля `global`).
  Руководство для реализации — `packages/core/src/config/README.md`.
- **Zod-схема задаёт только типы, диапазоны и связи; значения по умолчанию —
  в пресете `base`** (D-061). Накладка клиента явно повторяет все значения, о
  которых договорились с клиентом, даже если они совпадают с `base`: смена
  умолчаний продукта не меняет поведение клиента молча.
- В данных хранятся **ключи** (`outcome_code`, `stage_key`, `event_type_key`,
  `role_key`, `reason_code`, `service_type_key`), а не id. Ключ после создания
  не меняется, удаления нет, только `archived: true`. Архивный ключ остаётся
  читаемым в отчётах и выгрузках.
- Подписи — карты `{ "ru": "…", "kk": "" }`. Пустое `kk` показывает `ru`.

---

## 3. Формат пресета

### 3.1. Слои

Пресет — JSON (данные, а не код). Собирается из слоёв, каждый следующий
частично перекрывает предыдущий:

```
base  →  страновой (kz)  →  отраслевой (consulting-sales)  →  накладка клиента (crp)  →  локальные правки в БД
```

| Слой | Где лежит | Что содержит |
|---|---|---|
| `base` | `presets/base/preset.json` (в образе) | одно пространство, общие итоги, 4 роли, ручная раздача, значения по умолчанию всех ключей |
| `kz` | `presets/kz/preset.json` (в образе) | праздники и переносы РК, правило номеров РК, формы собственности (ИП с признаком `idIsPersonal`), пояс `Asia/Almaty`, `org.idRule = kz_bin`. Второй клиент в РК получает их без копирования |
| `consulting-sales` | `presets/consulting-sales/preset.json` (в образе) | групповые мероприятия + консультации, передача по типу услуги |
| накладка клиента | приватный `salemaikz/crm-deploy/clients/<клиент>/preset.json` и каталог `assets/` (логотип, шрифты); до его создания — `presets/clients/crp/` | название, бренд, лимиты, подписи «БР/БК», роли ЦРП. Без ПДн, цен договора и секретов |

Файл слоя (D-081): `meta`, `global` (частичный документ `global`),
`spaceDefaults` (частичный документ пространства — для каждого пространства),
`spaces.<ключ>` (частичный документ конкретного пространства). Документ
пространства собирается по слоям по порядку: в каждом слое сначала
`spaceDefaults`, потом `spaces.<ключ>`. `base` кладёт умолчания в
`spaceDefaults`, поэтому второе пространство получает их без копирования.
`meta.extends` — ключи слоёв, поверх которых написан слой, в порядке сборки
(подпоследовательность слоёв перед ним); `meta.schemaVersion` старше схемы
сборки — ошибка, младше — слой мигрируется. Слой сам по себе не проверяется
схемой (он неполный) — проверяется собранный набор.

Правила слияния (`packages/core/src/config/merge.ts`, D-082):
- объекты сливаются по полям, глубоко; отсутствующий ключ — «не менять»;
- `null` — значение («выключено»), а не удаление;
- массив сливается **по `key`**, если все элементы обоих массивов — объекты
  со строковым `key`; **по `date`**, если у всех вместо `key` есть `date`
  (`calendar.holidays`: корпоративный выходной клиента переживает обновление
  праздников слоя `kz`); новый элемент — в конец, существующий перекрывается
  частично, порядок нижнего слоя сохраняется;
- остальные массивы (`calendar.workdays`, `roles[].grants`, `rejectRules`,
  списки ключей) заменяются целиком;
- смесь элементов с ключом и без, повтор ключа, ключ `__proto__` — ошибка;
- удаления нет: пустой массив с ключом ничего не убирает, убирает
  `"archived": true`.
Тем же правилом правка из UI накладывается на текущую ревизию.

### 3.2. Скелет файла

```json
{
  "meta": { "key": "crp", "version": "2026.10.1", "schemaVersion": 1,
            "extends": ["base", "kz", "consulting-sales"], "requires": { "product": ">=1.0.0" } },
  "global": {
    "org": { "productName": { "ru": "CRM ЦРП" }, "timezone": "Asia/Almaty" },
    "calendar": { "holidays": [ { "date": "2026-10-26", "kind": "holiday", "note": "перенос" } ] },
    "roles": [ { "key": "operator", "label": { "ru": "Оператор" }, "grants": [ … ] } ]
  },
  "spaces": {
    "sales": {
      "distribution": { "mode": "auto_even", "dailyCap": 40 },
      "booking": { "eventTypes": [ { "key": "br", "behavior": "group", "label": { "ru": "Бизнес-разбор" }, "short": { "ru": "БР" } } ] }
    }
  }
}
```

Из Zod-схемы генерируется JSON Schema для подсказок в редакторе.

### 3.3. Проверка

Zod + `superRefine` проверяют документ целиком:
- ссылки между ключами существуют (итог → группа причин, услуга → команда,
  поле → роли, этап → воронка, тип мероприятия → направления);
- у каждого из 7 видов итога есть хотя бы один неархивный итог;
- в воронке продаж ровно один этап вида `won` и хотя бы один `lost`;
- шаги повторов разбираются (`+2h`, `nextWorkday@10:00`), и их не меньше
  `calling.retry.maxAttempts − 1`: у каждой попытки до списания есть свой
  срок;
- `distribution.capIncludes` — подмножество видов выдачи;
- роли проходят `roleValidator` (`ARCHITECTURE.md` §5.1): нет `own` вместе с
  `distribution.manage`, `pool.read`, `card.assign`, `client.transfer`; нет
  пишущих прав у `readOnly` (кроме `report.export` и `data.export_all`);
  действия отношений — только подмножество списка из кода отношения;
- ключи соответствуют `^[a-z][a-z0-9_]{1,39}$` и уникальны в своём списке;
- даты праздников — `YYYY-MM-DD`, время — `HH:MM`.

Документ, который не прошёл проверку, не записывается.

---

## 4. Как применяется

| Действие | Команда или экран | Что происходит |
|---|---|---|
| Первая установка | `crmctl config apply --layers base,consulting-sales,<путь к накладке>` | сборка слоёв → проверка → печать диффа → с `--yes` запись ревизий `source=preset`; создаются пространства и команды; ничего не удаляется |
| Обновление пресета | то же | дифф с текущей ревизией; применяются только ключи, у которых текущее значение равно значению из `preset_doc` прошлой ревизии `source=preset` (их не трогали UI и CLI); остальные — в отчёт «оставлено как у клиента»; `--force` перезаписывает и их (D-061). Ассеты накладки копируются в том `crm_assets` |
| Точечная правка | `crmctl config set <scope> <путь> <json>` | новая ревизия `source=cli` |
| Правка в интерфейсе | экраны «Настройки продаж», «Праздники», «Шаблоны» | сервер берёт текущую ревизию, проверяет `expectedRev` (иначе 409), накладывает изменение, проверяет схему, пишет ревизию `source=ui`, аудит |
| Откат | `crmctl config rollback <scope> <rev>` | новая ревизия с содержимым `rev` |
| Экспорт | `crmctl config export` и «Полная выгрузка» | документы `global` и пространств |
| Обновление продукта | `crmctl update` | после SQL-миграций — миграции настроек `vN → vN+1` (чистые функции в `packages/core/src/config/migrations/`) над живой ревизией каждой области; результат проверяется новой схемой и пишется **новой** ревизией `source=migration`, старая остаётся для отката (D-060); ошибка останавливает выкладку до переключения |

Когда изменение начинает действовать:
- раздача, лимит, расписание — со следующего тика; выданное не отзывается;
- правила повторов, сроки возврата — для новых итогов; уже назначенные
  `next_call_at` и `return_at` не пересчитываются;
- архивный итог принимается из офлайн-очередей ещё 72 часа;
- праздник — для расчётов после правки; уже назначенные сроки не сдвигаются;
- поля и права — со следующего запроса (кэш до 5 секунд);
- тема и подписи — со следующей загрузки страницы.

Ночная задача `config-integrity` ищет в данных ключи, которых нет в текущей
ревизии, и показывает их число администратору.

---

## 5. Кто меняет

| Кто | Что может | Как |
|---|---|---|
| Владелец продукта / сопровождение | всё | `crmctl config …` на сервере |
| Администратор (`users.is_admin`) | `global`: календарь и праздники, тема, подписи источников, роли (назначение сотрудникам, но не себе; роль с охватом `space` или `data.export_all` — с уведомлением директору), интеграции; лицензия | UI |
| РОП (разрешение `settings.sales`) | числа процесса: лимит, режим и окно раздачи, шаги и число повторов, срок возврата, лимит пропусков, порог просрочки, цель «звонков в час», тексты напоминаний; серии мероприятий и консультанты (разрешение `booking.manage`) | UI |
| Разрешение `settings.fields` | поля клиента, карточки, сделки | CLI к 1.11, редактор в UI — после 1.11 |
| Остальные | ничего | — |

К 1.11 в интерфейсе правятся только числа РОП, праздники, тексты шаблонов,
серии, консультанты, сотрудники и назначение ролей. Набор итогов, воронки,
роли и поля — через пресет и CLI. Редакторы — после 1.11, без переделки
хранения.

---

## 6. Параметры

Колонки: **Ключ** · **Тип** · **По умолчанию** (значение слоя `base`; пометка
«kz:» — значение странового слоя) · **ЦРП** (пресет) · **Кто меняет** (UI-роль
или CLI). «Пространство» — параметр в документе
пространства, иначе — в `global`.

### 6.1. Компания и язык (`global.org`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `org.productName` | i18n | «CRM» | «CRM ЦРП» | CLI |
| `org.timezone` | IANA | `UTC`; kz: `Asia/Almaty` | `Asia/Almaty` | CLI |
| `org.locales` | `('ru'\|'kk')[]` | `["ru"]` | `["ru"]` (kk позже) | CLI |
| `org.defaultLocale` | `ru\|kk` | `ru` | `ru` | CLI |
| `org.currency` | `KZT` | `KZT` (целые тенге, не настраивается дальше) | `KZT` | — |
| `org.legalForms` | `{key, label, aliases[], idIsPersonal}[]` | пусто; kz: ТОО, ИП и КХ (`idIsPersonal: true` — 12 цифр это ИИН, только HMAC; признак есть и в словаре ядра, профиль не может его снять, D-141), АО, ГКП, ГУ, ОО, ПК | ТОО, ИП, АО, ЖШС, LLP + полные написания | CLI |
| `org.idRule` | `kz_bin\|none` | `none`; kz: `kz_bin` | `kz_bin` (12 цифр) | CLI |
| `org.personIdRule` | `kz_iin_hmac\|none` | `none`; kz: `kz_iin_hmac` | `kz_iin_hmac` (только HMAC) | CLI |

При старте сервер проверяет, что `org.timezone` даёт ожидаемое смещение
(`Asia/Almaty` = UTC+5 с 2024 года). Иначе не стартует (старая tzdata).

### 6.2. Календарь (`global.calendar`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `calendar.workdays` | `1..7[]` (ISO) | `[1,2,3,4,5]` | `[1,2,3,4,5]` | CLI |
| `calendar.workHours` | `{start,end}` HH:MM | 09:00–18:00 | 09:00–18:00 | CLI |
| `calendar.callWindow` | `{start,end}` | 09:00–18:00 | 09:00–18:00 | РОП |
| `calendar.holidays` | `{date, kind: holiday\|workday, note}[]`, ключ слияния — `date` | пусто; kz: праздники и переносы РК 2026–2027 `[дозаполни: сверить с постановлением правительства]`, в т. ч. 26.10.2026 выходной | из слоя kz + корпоративные дни ЦРП | Администратор |

### 6.3. Номера (`global.phone`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `phone.country` | `KZ` | `KZ` (канон `7XXXXXXXXXX`) | `KZ` | CLI |
| `phone.mobilePrefixes` | `string[]` | 700–709, 747, 750–751, 760–764, 771, 775–778 | то же | CLI |
| `phone.reviewPrefixes` | `string[]` | `["770","774"]` — мобильные с отметкой «проверить номер» | то же (PROCESS вопрос 7) | CLI |
| `phone.landlinePrefixes` | `string[]` | 71x, 72x | то же | CLI |

### 6.4. Дедуп и источники (`global.dedup`, `global.sources`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `dedup.byOrgId` | bool | `true` | `true` | CLI |
| `dedup.byPhoneAndName` | bool | `true` | `true` | CLI |
| `dedup.pairs.sharedPhone` | bool | `true` | `true` | CLI |
| `dedup.pairs.nameAndHead` | bool | `true` | `true` | CLI |
| `sources[]` | `{key, label, kind, allowPersonNames, detailedReport, rejectRules[], holdRules[]}` | `manual`, `import`; `detailedReport: false` | + `new_base` («Новая база», kind `ingest`, `allowPersonNames: false`, `detailedReport: true`), `whatsapp_in`, `walk_in` | подпись — Администратор; остальное CLI |
| `sources[].rejectRules[]` | `{code, type: legalFormIn\|regionNotIn, values[]}` — запись не сохраняется, статус `rejected_rule` | пусто | у `new_base`: `legal_review` — ИП до ответа юриста (D-052) | CLI |
| `sources[].holdRules[]` | `{code, type: legalFormIn\|regionNotIn, values[]}` — клиент создаётся, не раздаётся | пусто | `region`: регион ≠ Астана; у `import`: ИП до ответа юриста | CLI |

### 6.5. Итоги звонка и причины (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `calling.outcomes[]` | `{key, kind, label, color, order, reasonGroup, requires{lpr, reason, callbackAt, contact, fields[], agreement}, importAliases[], archived}` | Не берёт, Занято (`no_answer`), Неверный номер, Перезвонить, Договорились, Не интересно, Не целевой, Просил не звонить | 7 итогов PROCESS 3.2: Не берёт · Номер не работает · Перезвонить · Договорились — записать · Не интересует · Не целевой · Полный отказ; `importAliases`: «Отключен», «Отключен/Не берет», «Недоступен», «Не имеет отношение», «Подтвержден», «Закрылся» | CLI (подписи и порядок в UI — после 1.11) |
| `calling.lprRequiredOnContact` | bool | `false` | `true` | РОП |
| `calling.lprNoRequiresInfo` | bool | `false` | `true` | РОП |
| `calling.undoSeconds` | int 0–10 | 5 | 5 (окно на устройстве, сервер отмены не знает) | РОП |
| `calling.offlineWindowHours` | int | 72 | 72 | CLI |
| `calling.callbackPastToleranceMin` | int | 5 | 5 | CLI |
| `calling.callbackPresets` | `string[]` | `+2h`, `nextWorkday@10:00` | `+2h`, `nextWorkday@10:00`, `nextEvent:br@10:00` | РОП |
| `reasons.<group>[]` | `{key, label, needsText, softness: soft\|hard, archived}` | короткие списки | PROCESS 3.2 и 4.2: группы `not_interested`, `not_target`, `do_not_call`, `bad_number`, `deal_lost` | CLI |

### 6.6. Повторы, возвраты, очередь (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `calling.retry.steps` | `string[]` (`+Nh`, `+Nm`, `nextWorkday@HH:MM`) | `+2h`, `nextWorkday@10:00` | то же | РОП |
| `calling.retry.maxAttempts` | int 1–10; шагов в `retry.steps` не меньше `maxAttempts − 1` | 3 | 3 | РОП |
| `calling.returnDays` | `{not_interested, deal_lost_soft}` int или `null` | `{90, 90}` | `{90, 90}` | РОП |
| `queue.order` | перестановка `callbacks, retries, returns, new` | как слева | как слева | CLI |
| `queue.mobileFirst` | bool | `true` | `true` | РОП |
| `queue.skipLimit` | int 0–50 | 10 | 10 | РОП |

### 6.7. Раздача и приём (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `distribution.mode` | `auto_even\|top_up\|manual\|off` | `manual` | `auto_even` | РОП |
| `distribution.schedule` | `{from, to, everyMin, workdaysOnly}` | 08:00–18:00, 60, `true` | то же | РОП |
| `distribution.dailyCap` | int 0–500 | 40 | 40 | РОП |
| `distribution.capIncludes` | `('auto'\|'manual'\|'return'\|'inbound'\|'proposal')[]` | `auto, manual, return` | `auto, manual, return` | CLI |
| `distribution.capOverride` | bool | `false` | `false` | CLI |
| `distribution.topUpKeep` | int | 10 (только для `top_up`) | — | РОП |
| `distribution.participantRoles` | `role_key[]` | роль с охватом `own` | `["operator"]` | CLI |
| `distribution.inbound` | `{rule: channel_owner_then_least_loaded, offHours: role_key}` | `channel_owner_then_least_loaded`, `rop` | то же | CLI |
| `intake.demandWorkdays` | int 1–30 | 7 | 7 | CLI |
| `intake.bufferDays` | число 0–3 | 0,5 | 0,5 (`needNext`, D-057) | CLI |
| `intake.maxBatch` | int ≤ 1000 | 1000 | 1000 | CLI |

### 6.8. Воронки и сделки (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `pipelines[]` | `{key, kind: sales, label, createDealOn: agreed\|client_created\|manual, stages[]}` | «Продажи»: Новая → КП → Счёт → Оплачено / Проиграно, `createDealOn: manual` | «Продажи ЦРП»: Записан → Пришёл → Переговоры/КП → Покупка (won) / Проигран (lost), `createDealOn: agreed` | CLI |
| `pipelines[].stages[]` | `{key, label, kind: open\|won\|lost, order, requires{fields[], booking, attendance, nextTask, amount, serviceType, reason}, staleDays, auto: on_agreed\|on_attended\|null}` | — | PROCESS 4.2; `staleDays` 14 / 7 / 14 | CLI |
| `serviceTypes[]` | `{key, label, routeToTeam, archived}` | «Услуга» | Мастер-группа, Консультация, SMM → `marketing`, Реклама → `marketing`, Автоматизация, Обучение, Другое | CLI |
| `deals.purchaseFutureLimitHours` | int | 36 | 36 | CLI |
| `teams[]` | `{key, label}` | пусто | `marketing` «Маркетинг» | CLI; руководителя назначает Администратор |
| `handoff.acceptSlaWorkdays` | int | 1 | 1 | РОП |
| `handoff.alarmTo` | `role_key[]` | `["manager"]` | `["rop"]` | CLI |

Колонки канбана обзвона — состояния карточки (код), не настройка.

### 6.9. Запись (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `booking.eventTypes[]` | `{key, behavior: group\|individual, label, short, capacity (у individual — null), durationMin, directions[] (ключи направлений; пусто — все)}` | пусто | `br` group «Бизнес-разбор» / «БР», 30 мест, 180 мин; `bk` individual «Бизнес-консультация» / «БК», 45 мин | CLI |
| `booking.horizonDays` | int | 28 | 28 | CLI |
| `booking.groupOptions` | int | 3 | 3 | CLI |
| `booking.consultStripDays` | int | 7 | 7 | CLI |
| `booking.consult.slotMinutes` | int | 45 | 45 | CLI |
| `booking.consult.hours` | `{workdays, start, end}` | пн–пт 09:00–18:00 | то же | CLI |
| `booking.directions[]` | `{key, label}` | пусто | программа, консалтинг, маркетинг, автоматизация, обучение, другое | CLI |
| `booking.grey.mode` | `assign\|suggest` | `suggest` | `assign` | РОП |
| `booking.grey.schedule` | `{first, last, stepMin}` | 09:00, 18:00, 30 | то же | CLI |
| `booking.duty.defaultRole` | `role_key` | `manager` | `rop` | CLI |
| `booking.noShow.callbackAt` | шаг | `nextWorkday@10:00` | то же | РОП |
| `booking.attendance.autoNoShowWorkdays` | int 1–10 или `null` (выкл) | 2 | 2 (PLAN В-11) | РОП |
| `booking.nextStep.taskAt` | шаг | `nextWorkday@10:00` | то же (задача «Записать на следующий шаг», D-049) | РОП |
| `reminders.days` | `('today'\|'tomorrow')[]` | оба | оба | РОП |
| `reminders.templates[]` | `{key, eventTypeKey, text}` с подстановками только из белого списка `{name} {date} {time} {place}` | общий текст | текст PROCESS 5.4 | РОП |

Серии мероприятий (`event_series`) и консультанты (`resources`) — рабочие
данные в таблицах, не в документе. Пресет может задать стартовую серию:
`booking.seedSeries[]` `{key, eventTypeKey (групповой тип), weekday, startTime,
durationMin, location, format: offline|online, capacity}` (у ЦРП: `br`,
четверг 15:00, 180 мин, офлайн, 30 мест);
`crmctl config apply` создаёт её, только если серий ещё нет.

### 6.10. Роли и доступ (`global.roles`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `roles[]` | `{key, label, readOnly, grants[{perm, scope}], relations[{key, params, actions[]}], fieldAccessDefault, menu[]}`; `actions` — подмножество списка из кода отношения (`ARCHITECTURE.md` §5.1) | Руководитель (`space`), Менеджер (`own`), Наблюдатель (`readOnly`, `space`) | Оператор (`own`), РОП (`space`, `data.export_all`), Консультант (`booked_with_me` с действиями явки, записи к себе, покупки, заметки), Директор (`readOnly`, `space`, `data.export_all`), Глава маркетинга (`handoff_to_my_team` с принятием и назначением), Маркетолог (`handoff_assigned_to_me`) | CLI; назначение сотрудникам — Администратор (не себе) |
| `team.fallbackOwnerRole` | `role_key` | роль с охватом `space` | `rop` (кому уходят дела при срочном отключении, D-066) | CLI |

До влития P4a схема проверяет у роли только `key` и `label`; остальные поля
роли подключит P4a вместе с `roleValidator` (`schema/roles.ts`).

Администратор — не роль, а признак учётки (`users.is_admin`). Дежурство — не
роль, а назначение на мероприятие (отношение `duty_today`). Матрица прав ЦРП —
PROCESS 8.2; её переводит в `grants` architect при сборке пресета (T2).

### 6.11. Поля (пространство и `global` для клиента)

Поля объектов `client` и `contact` лежат в `global.fields[]` (клиент общий на
установку, D-012), поля `card`, `deal`, `booking` — в `fields[]` документа
пространства (D-081). Ключ поля уникален среди полей `global` и пространства.
Варианты (`options`) есть только у `select` и `multiselect`.

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `fields[]` | `{key, object: client\|card\|deal\|booking\|contact, type, label, options[], access{<role>: edit\|read\|hidden, "*": …}, required{always, onOutcome[], onStage[]}, searchable, filterable, ingest, pii: none\|person\|contact, showOn{card, kanban, list}, archived}` | Источник (системное), Комментарий | Точная ниша (`select` + «Другое: текст», обязательна при `agreed`), регион и район, ОКЭД, размер; поле «руководитель» — `pii: person`; оператор не правит название и БИН | CLI к 1.11 |

Типы: `text`, `textarea`, `number`, `money` (целые тенге), `date`, `datetime`,
`boolean`, `select`, `multiselect`, `phone`, `email`, `url`, `user`. Значения
`url` принимаются только со схемой `http:`/`https:`, `email` — только адрес;
остальное отбрасывается с предупреждением на всех путях записи (D-051).
`pii` отмечает поле с ПДн: оно входит в реестр обезличивания (D-053), а
`pii: person` отбрасывается при приёме от источника с
`allowPersonNames = false` (D-052). Системные
поля (название, БИН, телефоны, владелец, состояние) — колонки; пресет может
переименовать или скрыть их для роли, но не удалить. Тип поля сменить нельзя:
нужен новый ключ и перенос значений через CLI.

### 6.12. Задачи, отчёты, уведомления, тревоги (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `tasks.overdueAlertMinutes` | int | 60 | 60 | РОП |
| `tasks.inboundReplyMinutes` | int | 15 | 15 | РОП |
| `tasks.askNextStep` | `{<role_key>: bool}` | все `false` | `consultant: true` | CLI |
| `reports.callsPerHourTarget` | int или `null` | `null` | 10 (мягкая цель: только число и отметка «ниже нормы», без блокировок и без красного) | РОП |
| `reports.tiles[]` | `{key, label, kind: outcome_count\|field_equals, params}` | пусто | плитки сводки РОП и директора | CLI |
| `export.allowedRoles` | `role_key[]` | `["manager"]` | `["rop","director"]` (выгрузка отчётов; полная выгрузка — разрешение `data.export_all` в роли, D-055) | CLI |
| `notifications.morningDigestAt` | HH:MM или `null` | 09:00 | 09:00 | РОП |
| `notifications.callbackSoonMinutes` | int или `null` | `null` | `null` (10 — со второй недели) | РОП |
| `notifications.quietHours` | `outside_work_hours\|none` | `outside_work_hours` | то же | CLI |
| `alerts.intakeStaleHours` | int или `null` | 26 (по `ingest_keys.last_used_at`, включая `demand`; только при активном ключе приёма) | `null` (D-056, PLAN В-3) | CLI |
| `alerts.stockMinDays` | число или `null` | `null` | `null` (D-057) | CLI |
| `reports.intakeTile` | bool | `true` | `false` (D-056) | CLI |
| `timeline.crossSpace` | `none\|summary\|full` | `none` | `none` | CLI |

### 6.13. Импорт (пространство)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `import.profiles[]` | `{key, label, columns{<колонка>: <поле>}, valueMaps{outcome, lpr, target}, ownerBy: column\|row_ranges, outcomePriority[], snapshotDate}` | «Простая таблица» | «Таблицы операторов ЦРП»: карта итогов (PROCESS 3.7), «диапазон строк → оператор», приоритет итогов в ячейке | сохраняется из экрана импорта (РОП, `import.run`); CLI |
| `import.maxFileMb` | int | 10 | 10 | CLI |
| `import.maxRows` | int | 20 000 | 20 000 | CLI |
| `import.rowsRetentionDays` | int | 14 | 14 | CLI |

### 6.14. Тема (`global.theme`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `theme.brandColor`, `theme.accentColor` | hex | нейтральные | токены бренда ЦРП (`docs/brand` crp-kz) | Администратор |
| `theme.fontPreset` | ключ пресета шрифтов (с `cyrillic-ext`) | `system` | шрифты бренда ЦРП | CLI |
| `theme.radius`, `theme.density` | `sm\|md\|lg`, `compact\|normal` | `md`, `normal` | по бренду | CLI |
| `theme.logo` | ключ ассета в образе или в каталоге `assets/` накладки (копируется в том `crm_assets` при `config apply`, D-061) | нейтральный | логотипы из `docs/brand/logo/` crp-kz без перерисовки | CLI (загрузка файла в UI — после 1.11, через architect) |
| `theme.statusStyle` | `color\|color_text_icon` | `color_text_icon` | `color_text_icon` (красный бренда не путается с «Не целевой») | CLI |

### 6.15. Пространства (`global.spaces`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `spaces[]` | `{key, label, enabled, default}` | `sales` «Продажи» | `sales` «Продажи» | CLI; второе пространство требует признака лицензии `spaces.multi` |

### 6.16. Безопасность и сессии (`global.security`)

| Ключ | Тип | По умолчанию | ЦРП | Кто |
|---|---|---|---|---|
| `security.sessionDays` | int | 30 (скользящий срок) | 30 | CLI |
| `security.inviteTtlHours` | int | 72 | 72 | CLI |
| `security.loginAttempts` | `{perPhone, perIp, windowMin}` | 5, 20, 15. По номеру — нарастающая задержка, а не блокировка (чужой не может перебором заблокировать вход оператору); по IP — блокировка на окно | то же | CLI |
| `security.phoneProbesPerDay` | int | 20 | 20 — общий счётчик проверок номера (D-040) | РОП |
| `audit.retentionDays` | int | 1095 | 1095 | CLI (чистит задача под `crm_owner`) |

---

## 7. Окружение установки

Файл `/etc/crm/app.env` (root, 0600). В репозитории — только
`deploy/env/*.env.example` без значений; файлы `*.env` в git и в чтение
агентам закрыты (`.gitignore`, `.claude/settings.json`).

| Переменная | Что | Обязательна | Секрет |
|---|---|---|---|
| `DATABASE_URL` | БД под ролью `crm_app` | да | да |
| `MIGRATE_DATABASE_URL` | БД под `crm_owner`, только для `migrate` | на сервере — да | да |
| `APP_ORIGIN` | адрес CRM (проверка `Origin`, cookie, ссылки приглашений); сравнивается после нормализации (`https://crm.x.kz/` = `https://crm.x.kz`). Пишет `crmctl install`. Без него мутирующие запросы получают 403 (D-153), поэтому в production приложение без него не стартует | в production — да | нет |
| `CRM_PROXY_SECRET` | секрет доверенного прокси (D-155): base64url от 32 символов. `crmctl install` генерирует, `crmctl update` дописывает в старый `app.env`; копия для nginx — `/etc/crm/nginx-proxy.d/secret.conf`, nginx ставит её в `X-Proxy-Secret`. Только при совпавшем секрете (сравнение за постоянное время) приложение верит `X-Real-IP`, `X-Forwarded-For` и `X-Via-Proxy`; прямые запросы из сети `crm_ingest` IP подделать не могут. Без секрета у всех IP «unknown» и лимиты входа общие, поэтому в production приложение без него не стартует | в production — да | да |
| `TRUST_X_REAL_IP` | устарела (D-155): больше ничего не включает, строку в старом `app.env` можно оставить. В production без `CRM_PROXY_SECRET` сообщение об отказе запуска напоминает об этом | нет | нет |
| `TRUSTED_PROXY_HOPS` | если перед nginx стоит цепочка своих прокси: сколько их (IP — N-е значение `X-Forwarded-For` справа вместо `X-Real-IP`). Читается тоже только при верном `X-Proxy-Secret`. По умолчанию `0` | нет | нет |
| `CRM_SECRETS_KID`, `CRM_SECRETS_KEY_<kid>` | ключ AES-256-GCM для секретов интеграций. Пишет `crmctl install` | для интеграций | да |
| `CRM_PHONE_HMAC_KEY` | HMAC номеров стоп-листа. Пишет `crmctl install` | да | да |
| `CRM_IIN_HMAC_KEY` | HMAC ИИН. Пишет `crmctl install` | да | да |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web-push | при `FEATURE_PUSH` | приватный — да |
| `LICENSE_PATH` | путь к файлу лицензии в томе. Пишет `crmctl install` | да | нет |
| `INGEST_PUBLIC` | `0` — `/api/ingest/` закрыт снаружи (по умолчанию): nginx и второй рубеж в приложении — запрос через nginx (верный `X-Proxy-Secret`) получает 404, запрос с `X-Via-Proxy` без верного секрета — 404 всегда | нет | нет |
| `INGEST_ACCEPTING` | `1` — приём ingest/v1 включён; `0` — выключен целиком, ответ 423 (рубильник на время разбора проблем источника) | нет | нет |
| `FEATURE_BK_WIZARD`, `FEATURE_PURCHASES`, `FEATURE_KANBAN`, `FEATURE_REPORTS_EXPORT`, `FEATURE_PUSH`, `FEATURE_MERGE`, `FEATURE_BULK_TRANSFER`, `FEATURE_IMPORT` | флаги модулей пилота — аварийные выключатели (D-047, D-062; таблица — PLAN §7.3) | нет | нет |
| `FEATURE_WAZZUP`, `FEATURE_TELEPHONY_ZADARMA`, `FEATURE_TELEPHONY_BEELINE` | флаги интеграций (D-025 crp-kz) | нет | нет |
| `TELEMETRY` | `off` по умолчанию | нет | нет |

Проверка при старте (`src/instrumentation.ts`): в production без `APP_ORIGIN` или без
`CRM_PROXY_SECRET` веб-приложение не запускается и пишет в лог, какой строки не хватает и что
делать (`sudo crmctl update` допишет секрет). `crmctl update` дописывает недостающий секрет до
проверки новой версии, поэтому обновление старой установки этим не ломается.

Ключи `CRM_*_KEY` не лежат в БД и не попадают в её бэкап. Их потеря делает
стоп-лист и секреты интеграций нечитаемыми, поэтому копия хранится вне
сервера (`docs/PLAN.md` §9, В-22). Ротация HMAC-ключей не
предусмотрена к 1.11.

---

## 8. Включение модулей: флаг, лицензия, переключатель

Модуль интеграции работает, только если одновременно:
1. включён флаг окружения (`FEATURE_*`) — решение о готовности кода;
2. есть признак в лицензии (`features`) — решение о продаже;
3. администратор включил интеграцию в UI — решение клиента.

В демо и на стенде флаги включены, в production выключены до приёмки (как D-025
crp-kz). Для Wazzup и Zadarma добавляется четвёртое условие — письменное
решение ЦРП о передаче ПДн за рубеж (`docs/INTEGRATIONS.md`).

---

## 9. Что не настраивается

7 видов итога и 9 состояний карточки; статусы записи; охваты прав и правило
«чужое = несуществующее»; лента только с добавлением; идемпотентность итогов,
записей и покупок; «пара не делится»; стоп-лист навсегда (снять может только
РОП с комментарием); деньги в целых тенге; время в epoch-мс; хранение ИИН
только HMAC (в том числе у ИП); список мутаций безопасности, которые работают
в любом состоянии лицензии (D-054); действия отношений сверх списка из кода;
запрет скриптов, формул и произвольного CSS в настройках.
