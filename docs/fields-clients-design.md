# K2 + C2: движок полей и клиенты — дизайн для builder

Нормативно: CONFIG §6.11, ARCHITECTURE §2.2, §4.6, §5.2–5.3, PROCESS §1, §2.3, §8.3, §9,
D-015, D-017, D-020, D-022, D-037, D-038, D-040, D-051, D-052, D-068, D-071…D-075, D-121…D-126.
Поток `stream:calling`. Чего здесь нет и не делаем сейчас: «Предложить контакт» (C9), заметки и
итоговый отчёт (C8), итоги звонка и «Номер не работает» из итога (C5), слияние (B9b).

---

## 1. Что уже есть (K2, ядро — сделано architect)

`packages/core/src/fields/` — чистые функции, тесты `fields.test.ts` (14 тестов, зелёные).

| Функция | Что делает |
|---|---|
| `resolveAccess(def, viewer)` | доступ к полю: `access[роль]` → `access['*']` → `fieldAccessDefault`; `edit` без пишущего права или у архивного поля → `read`; нет роли → `hidden` (D-121) |
| `visibleKeys` / `hiddenKeys` / `accessMap` / `filterableField` | списки для проекции и фильтров; фильтр по скрытому или не `filterable` полю → `null` (маршрут: 400) |
| `coerceValue(def, raw, ctx, current)` | тип, длина, варианты (архивный — только если уже выбран), `money` — целые тенге, `phone` — канон `7XXXXXXXXXX`, `email` — адрес, `url` — только http(s) без логина в адресе (D-051) |
| `safeHttpUrl`, `normalizeEmail`, `mailtoHref` | повторная проверка при выводе |
| `buildFieldValidator({fields, object, mode, viewer, transition, allowPersonNames, onlyEmpty, ctx})` | `.validate(patch, current)` → `{ok, patch, next, changes, errors, warnings}`; `.missingRequired(values)` (D-122) |
| `projectFor(viewer, object, fields, values)` | `{fields: ProjectedField[], values}` — без скрытых и без ключей, которых нет в настройках; у `url`/`email` готовый `href` |
| `projectValues` | только видимые значения (строки списка) |
| `canSeeFieldChange`, `visibleFieldRefs` | видимость события «поле было → стало» (D-125) |
| `buildSearchNorm`, `parseSearchQuery`, `searchableKeys`, `foldForSearch` | поиск (D-123) |
| `CLIENT_SYSTEM_FIELDS`, `CONTACT_SYSTEM_FIELDS`, `validateSystemPatch`, `reservedKeyIssues` | системные поля-колонки и их права (D-124); 12 цифр, которые могут быть ИИН, — только `hiddenId` (HMAC), не `org_id` и не лента (D-181) |
| `orgIdNature(form, kind, legalForms)` | `bin` / `personal` / `uncertain`: одно правило для правки клиента и приёма (D-141, D-181) |

Ключи системных полей (они же ключи в API и в ленте): клиент — `name`, `legal_form`, `org_id`,
`region`, `address`, `email`, `website`; контакт — `name`, `position`, `is_decision_maker`,
`call_hint`, `note`.

**Не сделано в ядре (не моя зона на этом шаге):**
- корневой экспорт: в `packages/core/src/index.ts` строка `export * as fields from './fields';` и
  `'fields'` в списке ключей `packages/core/src/index.test.ts` — координатор;
- адаптер форм собственности настроек к `names.LegalForm` (`{key, label, aliases, idIsPersonal}` →
  `{key, full, short}`: алиас из одного слова до 6 букв — `short`, иначе `full`) —
  `packages/core/src/names/fromConfig.ts`, задача T1-a ниже.

---

## 2. Права и охват (C2)

Клиент, контакты, номера и лента видны, если видна карточка клиента (D-072). Всё SQL — через
`scopeSql`; в шаблон вставляется через `scoped(sql)`.

| Действие | Обёртка (`perm`, `target`) | Охват в SQL |
|---|---|---|
| Список и поиск | `client.read`, `section` | `scopeSql(v, 'card', 'client.read', {alias:'c'})` по карточкам текущего пространства |
| Карточка клиента, лента | `client.read`, `object` | `scopeSql(v, 'client', 'client.read')`; лента — `scopeSql(v, 'client_event', 'card.read')` |
| Правка полей клиента | `client.edit`, `object` | блокировка строки с `scopeSql(v, 'client', 'client.edit')`; поля `identity` — плюс выражение `scopeSql(v,'client','client.edit_identity')` в SELECT |
| Номер: добавить, «не работает», основной | `client.edit`, `object` | `client` или `client_phone` с `client.edit` |
| Контакт: добавить, править, в архив | `client.edit`, `object` | `client` или `contact` с `client.edit` |

Правило отказа (D-124): объект не найден охватом записи → повторное чтение охватом `client.read`
(для номера и контакта — их сущность): не виден → `NotFoundError` (404), виден → `ForbiddenError`
(403). Функция `throwNotFoundOrForbidden(viewer, sql, entity, id)` — в `clients/repo.ts`.
**Порядок в каждой мутации: сначала блокировка с охватом, потом всё остальное** — иначе чужой
id оставит след (строку `phone_probes`, задачу), и прогон изоляции упадёт на снимке таблиц.
Исключение — блокировка приёма `INTAKE_LOCK_KEY`: где она нужна (добавление номера; правка с
`org_id`/`legal_form`), она берётся **до** строки клиента — как в приёме (D-126). Она не оставляет
следов, поэтому правилу «без следов до охвата» не мешает.

---

## 3. Файлы

Всё — зона `stream:calling`. Тексты — `messages/ru/clients.json` (пространство имён `clients`).

| Файл | Что |
|---|---|
| `src/server/domain/clients/config.ts` | `loadClientsConfig(viewer)`: из `getActiveConfig()` — `fields` (= `global.fields` + `fields` пространства `viewer.spaceId`), `roles` (`{key, fieldAccessDefault, archived}`), `legalForms` (`LegalFormRef[]`), `namesForms` (через адаптер T1-a), `phoneRules` (`global.phone`), `probesPerDay` (`global.security.phoneProbesPerDay`), `searchable` (= `searchableKeys(fields, roles)`), `rev`. `fieldViewer(viewer, cfg)` → `{roleKey, fieldAccessDefault, canEdit: !viewer.readOnly && can(viewer,'client.edit')}` |
| `src/server/domain/clients/input.ts` | Zod-схемы тел запросов (`.strict()`), разбор курсора и фильтров списка |
| `src/server/domain/clients/types.ts` | DTO (раздел 5) |
| `src/server/domain/clients/repo.ts` | весь SQL клиентов, карточки в шапке, номеров, контактов, проверок номера (раздел 4) |
| `src/server/domain/clients/service.ts` | `getClientCard`, `listClients`, `updateClient`, `findSurvivor` |
| `src/server/domain/clients/phones.ts` | `addPhone`, `updatePhone` (логика; SQL — в repo.ts) |
| `src/server/domain/clients/contacts.ts` | `addContact`, `updateContact` |
| `src/server/domain/clients/searchNorm.ts` | `refreshSearchNorm(tx, viewer, clientId, cfg)`: номера (с охватом) + `buildSearchNorm` + UPDATE |
| `src/server/domain/clients/index.ts` | публичный API модуля для `src/app` (без repo) |
| `src/server/domain/timeline/kinds.ts` | реестр видов событий: `{group, dataKeys[]}` (раздел 6) |
| `src/server/domain/timeline/repo.ts` | `appendEvents(tx, events)`, `readFeed(...)` |
| `src/server/domain/timeline/index.ts` | `listFeed(viewer, clientId, opts)` с проекцией |
| `src/app/api/clients/route.ts` | `GET` список |
| `src/app/api/clients/[id]/route.ts` | `GET` карточка, `PATCH` правка |
| `src/app/api/clients/[id]/feed/route.ts` | `GET` лента |
| `src/app/api/clients/[id]/phones/route.ts` | `POST` добавить номер |
| `src/app/api/clients/[id]/contacts/route.ts` | `POST` добавить контакт |
| `src/app/api/clients/phones/[id]/route.ts` | `PATCH` номер (один параметр пути — для манифеста; статический сегмент `phones` Next ставит выше `[id]`) |
| `src/app/api/clients/contacts/[id]/route.ts` | `PATCH` контакт |
| `src/app/(op)/clients/page.tsx` | список «Клиенты» (URL `/clients`) |
| `src/app/(op)/clients/[id]/page.tsx` | карточка клиента (URL `/clients/[id]`) — одна для всех ролей |
| `src/app/(op)/clients/_ui/*.tsx` | компоненты страницы (раздел 7) |
| `tests/isolation/manifest/clients.ts` | манифест (раздел 8.3) |
| `tests/unit/clients/*.test.ts`, `tests/integration/clients/*.test.ts`, `tests/e2e/calling-client-card.spec.ts` | тесты (раздел 8) |

Route handler тонкий: `route({perm, target}, async ({req, params, viewer}) => service(...))`.
Страница: `export default page({perm:'client.read', target:'object'}, async ({viewer, props}) => …)`;
`params` в Next 16 — Promise (читать `node_modules/next/dist/docs/` до кода).

---

## 4. Репозиторий: запросы и индексы

Обозначения: `S(entity, perm)` = `${scopeSql(viewer, entity, perm)}`. Все запросы — через
`scoped(sql)`. Условные части — только параметрами с NULL (`(${x}::text[] IS NULL OR …)`), без
склейки SQL.

**4.1. Клиент для карточки** — PK `clients`, охват по `cards_client_idx`:
```sql
SELECT cl.id, cl.kind, cl.name, cl.legal_form, cl.org_id, cl.region, cl.address, cl.email, cl.website,
       cl.custom, cl.source_kind, cl.merged_into_id, cl.created_at, cl.updated_at,
       (S(client,'client.edit')) AS can_edit, (S(client,'client.edit_identity')) AS can_identity
FROM clients cl WHERE cl.id = ${id} AND S(client,'client.read')
```
`merged_into_id IS NOT NULL` → API 404; страница вызывает `findSurvivor` (подъём по цепочке, не
глубже 8, с охватом `client.read` у выжившего) и делает `redirect`, иначе `notFound()`.

**4.2. Карточка обзвона текущего пространства** — `UNIQUE (space_id, client_id)`:
```sql
SELECT c.id, c.state, c.hold_reason, c.next_call_at, c.attempts, c.lpr, c.is_target, c.last_outcome_code,
       c.calls_total, c.no_answer_total, c.connects_total, c.first_connect_at, c.last_connect_at, c.last_touch_at,
       ou.name AS owner_name, au.name AS acting_name
FROM cards c LEFT JOIN users ou ON ou.id = c.owner_user_id LEFT JOIN users au ON au.id = c.acting_user_id
WHERE c.client_id = ${id} AND c.space_id = ${viewer.spaceId} AND S(card,'card.read')
```

**4.3. Номера** — `UNIQUE (client_id, digits)`:
```sql
SELECT cp.id, cp.digits, cp.ext, cp.kind, cp.is_working, cp.is_primary, cp.has_whatsapp, cp.contact_id, cp.created_at
FROM client_phones cp WHERE cp.client_id = ${id} AND S(client_phone,'client.read')
ORDER BY cp.is_primary DESC, cp.is_working DESC, cp.created_at, cp.id
```
**4.4. Контакты** — `contacts_client_idx`: то же с `ct.archived_at IS NULL`,
`ORDER BY ct.is_decision_maker DESC, ct.created_at, ct.id`.

**4.5. Список** — охват по `cards_queue_idx`/`cards_acting_idx`, поиск по `clients_search_trgm`,
фильтр полей по `clients_custom_gin`:
```sql
SELECT c.id AS card_id, cl.id, cl.name, cl.custom, c.state, c.hold_reason, c.next_call_at,
       c.last_touch_at, COALESCE(c.last_touch_at, c.created_at) AS sort_at
FROM cards c JOIN clients cl ON cl.id = c.client_id
WHERE c.space_id = ${viewer.spaceId} AND S(card,'client.read' {alias:'c'}) AND cl.merged_into_id IS NULL
  AND (${states}::text[] IS NULL OR c.state = ANY(${states}::text[]))
  AND (${p1}::text IS NULL OR cl.search_norm LIKE ${p1} OR cl.search_norm LIKE ${p2})
  AND cl.custom @> ${jsonParam(filter)}            -- '{}' без фильтров
  AND (${curAt}::bigint IS NULL OR (COALESCE(c.last_touch_at, c.created_at), c.id) < (${curAt}, ${curId}))
ORDER BY sort_at DESC, c.id DESC LIMIT ${limit + 1}
```
`p2 = p1`, если у `parseSearchQuery` один шаблон. `kind:'short'` → ответ `{items:[], hint:'short'}` без
запроса. Лимит: 50 без поиска, 20 с поиском (PROCESS 8.3). Фильтр поля (`f.<key>=<значение>`):
`filterableField` → иначе 400 `detail:'field_filter'` (одинаково для «нет поля» и «скрыто»); значение
через `coerceValue`; `select`/`text`/`number`/`money`/`date`/`boolean` → `{key: v}`, `multiselect` →
`{key: [v]}`. Главный номер строк — вторым запросом
`… FROM client_phones cp WHERE cp.client_id = ANY(${ids}) AND cp.is_working AND S(client_phone,'client.read')`.

**4.6. Блокировка для правки** (клиент; контакт и номер — так же своей сущностью):
```sql
SELECT cl.…, cl.custom, (S(client,'client.edit_identity')) AS can_identity
FROM clients cl WHERE cl.id = ${id} AND cl.merged_into_id IS NULL AND S(client,'client.edit') FOR UPDATE OF cl
```
UPDATE после проверки — с тем же охватом: `UPDATE clients cl SET … WHERE cl.id = ${id} AND S(client,'client.edit')`.
`custom` пишется целиком (`next` из валидатора) — строка заблокирована. `iin_hmac = COALESCE(hiddenId,
iin_hmac)` (D-181). Нарушение `clients_org_uq` или `clients_iin_uq` (`isUniqueViolation`) → 409.

**4.7. Проверка номера (D-126)** — внутри транзакции; блокировка приёма — до блокировки клиента:
```sql
SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY});                                  -- D-022
SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${me} AND day = ${viewer.today};  -- phone_probes_user_day_idx
SELECT 1 FROM stop_list WHERE phone_hmac = ${phoneHmac(digits)};                   -- PK
SELECT EXISTS (SELECT 1 FROM client_phones cp JOIN clients o ON o.id = cp.client_id
               WHERE cp.digits = ${digits} AND cp.client_id <> ${id} AND o.merged_into_id IS NULL) AS taken;  -- client_phones_digits_idx
INSERT INTO phone_probes (id, user_id, day, path, matched, created_at) VALUES (…, 'add_phone', ${taken OR stopped}, …);
```
Запрос `taken` — единственное место модуля без `scopeSql`: глобальная проверка существования,
возвращает только булево, наружу уходит одинаковым ответом (D-126). Функция в repo.ts называется
`phoneTakenElsewhere` и помечена комментарием со ссылкой на D-126.

**4.8. Лента** — `clients_merged_idx` для цепочки, `client_events_feed_idx` для чтения:
```sql
WITH RECURSIVE chain(id, depth) AS (
  SELECT ${id}::text, 0
  UNION ALL SELECT m.id, chain.depth + 1 FROM clients m JOIN chain ON m.merged_into_id = chain.id WHERE chain.depth < 8)
SELECT ev.id, ev.kind, ev.at, ev.actor_id, u.name AS actor_name, ev.ref_type, ev.ref_id, ev.deal_id, ev.data
FROM client_events ev LEFT JOIN users u ON u.id = ev.actor_id
WHERE ev.client_id IN (SELECT id FROM chain) AND S(client_event,'card.read')
  AND ev.kind = ANY(${kinds}::text[])
  AND NOT (ev.kind = 'field.changed' AND COALESCE(ev.data->>'sys','false') <> 'true'
           AND NOT (((ev.data->>'obj') || ':' || (ev.data->>'field')) = ANY(${visibleRefs}::text[])))
  AND (${curAt}::bigint IS NULL OR (ev.at, ev.id) < (${curAt}, ${curId}))
ORDER BY ev.at DESC, ev.id DESC LIMIT ${limit + 1}
```
`kinds` — все виды реестра (или виды выбранных групп); `visibleRefs = visibleFieldRefs(fv, cfg.fields)`.
Перед этим — 4.1 (клиент не виден → 404, а не пустая лента). Лимит 50.

**4.9. Запись события** — `appendEvents(tx, events)`: `INSERT INTO client_events (id, client_id,
space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)`; без охвата, вызывается только
внутри транзакции, где объект уже заблокирован с охватом. `space_id = viewer.spaceId`,
`actor_id = viewer.userId`, `at = viewer.now`. Не экспортируется из `timeline/index.ts` в `src/app`.

---

## 5. API

Ответы — JSON, ошибки — `{error, detail?}` обёртки. Ошибки полей — `400` с телом
`{error:'bad_request', detail:'fields', issues:[{key, code}]}` (обработчик возвращает `Response`
сам; в `issues` только ключи и коды).

| Метод и путь | Тело / параметры | Ответ |
|---|---|---|
| `GET /api/clients` | `q`, `state` (повторяемый, закрытый список 9 состояний), `f.<key>`, `cursor`, `limit ≤ 50` | `{items: ClientRow[], next: string\|null, hint?: 'short'}` |
| `GET /api/clients/[id]` | — | `ClientCardDto` |
| `PATCH /api/clients/[id]` | `{set:{system?:{…}, custom?:{…}}, expect:{system?:{…}, custom?:{…}}}` — в `expect` те же ключи, что в `set`, значения как их видел интерфейс | `ClientCardDto`; `409` если хоть одно `expect` не совпало (D-124) |
| `GET /api/clients/[id]/feed` | `cursor`, `groups` (через запятую из реестра) | `{items: FeedItem[], next}` |
| `POST /api/clients/[id]/phones` | `{opId: uuid, phone: string, contactId?: string\|null}` | `{status:'added', phone: PhoneDto}` или `{status:'review'}`; `400 detail:'phone_invalid'\|'contact'` |
| `PATCH /api/clients/phones/[id]` | `{working: false}` или `{primary: true}` (ровно одно) | `PhoneDto[]` клиента |
| `POST /api/clients/[id]/contacts` | `{opId: uuid, system:{…}, custom:{…}}` | `ContactDto` |
| `PATCH /api/clients/contacts/[id]` | как `PATCH` клиента, плюс `{archived: true}` отдельным телом | `ContactDto` |

DTO (`clients/types.ts`):
- `ClientCardDto = { id, kind, name, legalForm, orgId, region, address, email, emailHref, website,
  websiteHref, sourceKind, updatedAt, can:{edit, editIdentity}, card: CardHeadDto|null, phones:
  PhoneDto[], primaryPhone: PhoneDto|null, decisionMaker: {contactId, name}|null, contacts:
  ContactDto[], fields: Projection }`;
- `CardHeadDto = { id, state, holdReason, nextCallAt, attempts, lpr, isTarget, lastOutcomeCode,
  ownerName, actingName, counters:{callsTotal, noAnswerTotal, connectsTotal, firstConnectAt,
  lastConnectAt, lastTouchAt} }` — счётчики PROCESS 9.2 берутся с карточки, без пересчёта;
- `PhoneDto = { id, e164, ext, kind, working, primary, contactId, hasWhatsapp }`; `primaryPhone` —
  рабочий основной, иначе первый рабочий, иначе null;
- `ContactDto = { id, name, position, isDecisionMaker, callHint, note, fields: Projection }`;
- `ClientRow = { id, cardId, name, state, holdReason, nextCallAt, lastTouchAt, primaryPhone: e164|null,
  values }` (`values` — `projectValues` только полей с `showOn.list`);
- `FeedItem = { id, kind, group, at, actor:{id, name}|null, refType, refId, dealId, data }` — `data`
  только с ключами из реестра вида.

`emailHref`/`websiteHref` — `mailtoHref`/`safeHttpUrl` от значения колонки (D-051).

### 5.1. `PATCH` клиента — порядок в одной транзакции
1. `cfg = loadClientsConfig(viewer)` (до транзакции).
2. В `set.system` есть `org_id` или `legal_form` → `pg_advisory_xact_lock(INTAKE_LOCK_KEY)` (D-126).
   Затем блокировка 4.6; нет строки → `throwNotFoundOrForbidden`.
3. Сверить `expect` с текущими значениями (системные — по колонкам, свои — по `custom`); ключи
   `expect` ≠ ключи `set` → 400; расхождение → `ConflictError`.
4. `validateSystemPatch({object:'client', patch:set.system, current, can:{identity: row.can_identity,
   edit: true}, legalForms, clientKind: row.kind, personalIdHmac})` и `buildFieldValidator({mode:'user',
   viewer: fv, object:'client'}).validate(set.custom, row.custom)`; ошибки обоих → один 400 с `issues`.
   `personalIdHmac` (= `iinHmac`) передаётся только при `org.personIdRule = kz_iin_hmac`; без него номер,
   который может быть ИИН, — 400 `type` (D-181).
5. Нет изменений и нет `hiddenId` → вернуть карточку без записи.
6. `name` изменилось → `name_norm = names.normalizeCompanyName(name, cfg.namesForms)`.
7. UPDATE 4.6 (`custom = next`, `updated_at = viewer.now`), затем `refreshSearchNorm`.
8. По событию `field.changed` на каждое изменение (раздел 6). Всё в той же транзакции.

### 5.2. `POST` номера — порядок (D-126)
0. `pg_advisory_xact_lock(INTAKE_LOCK_KEY)` — первой, как в приёме (обратный порядок давал 40P01).
1. Блокировка клиента с охватом `client.edit` (4.6 без `can_identity`); нет → 404/403.
2. `phone.parsePhone(phone, cfg.phoneRules)`: не номер или нерабочий → 400 `phone_invalid`.
3. У этого клиента такой номер уже есть → `{status:'added', phone}` (повтор безопасен; проверка номера
   не считается — это свой клиент).
4. `contactId` — контакт этого клиента, не в архиве, с охватом `contact`/`client.edit`, иначе 400 `contact`.
5. 4.7: счётчик за сегодня, стоп-лист, `taken`, строка `phone_probes` (блокировка приёма уже взята в п. 0).
6. `n ≥ probesPerDay` или `stopped` или `taken` → задача РОП (`tasks`: `kind 'check'`, `source 'review'`,
   `assignee_user_id NULL`, `client_id = id`, `space_id = viewer.spaceId`, `title` = номер `+7…`,
   `source_key = 'add_phone:' || opId`, `ON CONFLICT DO NOTHING`), ответ `{status:'review'}`. В ленту
   ничего не пишется.
7. Иначе `INSERT client_phones (id = opId, …) ON CONFLICT (id) DO NOTHING`; `is_primary = TRUE`, если у
   клиента нет рабочего основного; `kind` из разбора; событие `phone.added`; `refreshSearchNorm`.

### 5.3. `PATCH` номера
- `{working:false}` («Номер не работает» вручную): `is_working = FALSE, is_primary = FALSE`; если номер был
  основным — основным становится самый ранний рабочий. События `phone.not_working` и (если сменился)
  `phone.primary`. Состояние карточки не меняется: перевод в «Без рабочего номера» и «Списан» — итог
  `bad_number` (C5). Вернуть номер в рабочие в v1 нельзя (нужна проверка стоп-листа; после 1.11).
- `{primary:true}`: только рабочий номер; сначала снять `is_primary` у прежнего (индекс
  `client_phones_one_primary`), потом поставить; событие `phone.primary`.

### 5.4. Контакты
`POST`: блокировка клиента (`client.edit`), `validateSystemPatch({object:'contact'})` +
`buildFieldValidator({object:'contact'})`, `INSERT contacts (id = opId) ON CONFLICT (id) DO NOTHING`,
событие `contact.added`. `PATCH`: как `PATCH` клиента (блокировка `contacts ct … S(contact,'client.edit')`,
`expect`, события `field.changed` с `obj:'contact', contactId`). `{archived:true}` → `archived_at`,
событие `contact.archived`. Контакты в `search_norm` не входят (v1).

---

## 6. Лента: виды событий (D-125)

Реестр `timeline/kinds.ts`: `{ kind: { group, dataKeys } }`. Чтение отдаёт `data` только с ключами
`dataKeys`; вид не из реестра в ленту не попадает (фильтр `kind = ANY`). Подписи строит интерфейс
по `kind` и `data` (PROCESS 9.1). Группы: `calls`, `messages`, `bookings`, `deals`, `tasks`, `notes`,
`system`.

| Вид | Группа | `data` | Кто пишет |
|---|---|---|---|
| `field.changed` | system | `{obj, sys, field, before, after, contactId?}` | C2 (клиент, контакт); позже C5/C8 (карточка, сделка) |
| `phone.added` / `phone.not_working` / `phone.primary` | system | `{phoneId}` — без цифр: номер берётся из списка номеров карточки | C2; `phone.not_working` также C5 |
| `contact.added` / `contact.archived` | system | `{contactId}` | C2 |
| `call`, `call.voided` | calls | коды итога, вид, длительность — задаёт C5 | C5 |
| `note.created` | notes | `{noteId}`; текст — из `notes` при чтении (C8) | C8 |

Остальные виды (записи, сделки, задачи, сообщения, системные из PROCESS 9.1) добавляют их модули
строкой в реестр. Событие `field.changed` скрытого для роли поля не выходит из БД (фильтр 4.8) и
перепроверяется `canSeeFieldChange` при проекции. В `before`/`after` значения пишутся как есть
(колонка `data` — в реестре ПДн, обезличивание чистит значения).

---

## 7. Интерфейс

Мобильный в первую очередь, минимум элементов, кит `src/ui/kit` (одна primary-кнопка на экран,
цели ≥ 44 px, состояние = цвет + значок + текст).

**Карточка `/clients/[id]`** — серверная страница собирает `ClientCardDto` и первую страницу ленты.
- Сетка: `lg:grid-cols-[minmax(0,1fr)_400px]`; на телефоне — одна колонка, лента ниже.
- Шапка: название (h1), под ним форма собственности и БИН мелко; строка ЛПР (имя, должность);
  главный номер `+7 709 123 45 67`; `Badge` состояния карточки (цвет + значок + подпись из локали),
  «Перезвонить: дата время» при `next_call_at`; владелец (и временный) мелко.
- **Одна главная кнопка «Позвонить»** — `<a href="tel:+7…">` (`buttonClass('primary')`); на телефоне
  закреплена внизу экрана (`sticky bottom-0`, отступ под safe-area). Нет рабочего номера — кнопки нет,
  вместо неё `Alert` «Нет рабочего номера».
- Счётчики — 4 `Stat`: звонков, попыток (недозвонов), дозвонов, последний контакт (2×2 на телефоне).
- Поля — `Card` со списком «подпись — значение» (подписи из `label` настроек, `kk` → `ru`);
  ссылки и почта — только `href` из DTO, `rel="noopener noreferrer"`, `target="_blank"` у ссылок.
  Кнопка «Изменить» (secondary) открывает `BottomSheet` на телефоне / `Modal` на ноутбуке с полями
  `access:'edit'`; отправка `PATCH` с `expect`; 409 → `Toast` «Данные изменились» и `router.refresh()`;
  400 → подсветка полей по `issues`.
- Номера — `List`: номер, тип, `Badge` «основной» / «не работает»; меню действий «Сделать основным»,
  «Не работает». «Добавить номер» (text-кнопка) → поле ввода; `opId = crypto.randomUUID()` один на
  попытку (повтор при сбое сети с тем же `opId`); ответ `review` → нейтральный `Toast` «Номер
  отправлен на проверку».
- Контакты — `List`, ЛПР первым; добавить и править тем же `BottomSheet`/`Modal`.
- Лента — `Chip`-фильтр групп; события группы `system` по умолчанию свёрнуты в строку «Системные:
  N» (раскрытие — локально); «Показать ещё» по курсору (`GET …/feed?cursor=`). Время — `Intl` в поясе
  `viewer.timeZone`.
- Клиентские компоненты получают только DTO; скрытых полей и чужих данных в props нет.

**Список `/clients`** — поиск (`Input` с подсказкой «от 3 букв или 5 цифр»), `ChipGroup` состояний,
список строк (название, состояние, главный номер, последнее касание); пусто → `EmptyState`.

Файлы UI: `_ui/ClientHeader.tsx`, `_ui/CallButton.tsx`, `_ui/Counters.tsx`, `_ui/FieldsCard.tsx`,
`_ui/FieldsForm.tsx` (client), `_ui/PhonesCard.tsx` (client), `_ui/ContactsCard.tsx` (client),
`_ui/Feed.tsx` (client), `_ui/feedLabels.ts` (подписи по виду), `_ui/format.ts` (номер, дата).

---

## 8. Тесты

**8.1. Unit** (`tests/unit/clients/`): схемы `input.ts` (лишний ключ → ошибка, `expect` ≠ `set`,
`opId` не uuid), курсор (кодирование/разбор, мусор → 400), сборка DTO (`primaryPhone`, `decisionMaker`,
`href`), реестр ленты (у каждого вида есть группа и подпись в `messages/ru/clients.json`).

**8.2. Интеграционные** (`tests/integration/clients/`, Postgres 16, мир — `tests/integration/access/world.ts`
плюс ревизия настроек с полями: одно `edit`, одно `read`, одно `hidden` для оператора, одно
`searchable`):
- `card.test.ts`: шапка, счётчики с карточки, главный номер и ЛПР; слитый клиент — 404 в API,
  выживший находится `findSurvivor`.
- `edit.test.ts`: правка → `field.changed` с `before`/`after` на каждое поле, без изменений — ни
  одного события; `expect` не совпал → 409; оператор меняет `name`/`org_id` → 400 `forbidden`; РОП
  может; скрытое поле → 400 `unknown_field`; `javascript:` в `website` и в поле `url` → 400; смена
  названия обновляет `name_norm` и `search_norm`; занятый БИН → 409; директор → 423.
- `phones.test.ts`: свободный номер → `added`, основной; повтор с тем же `opId` и тот же номер —
  одна строка; номер другого клиента → `review`, строки номера нет, `phone_probes.matched = true`,
  задача `add_phone:<opId>`; номер из стоп-листа → `review`; 21-я проверка за сутки → `review` даже
  для свободного номера; два параллельных добавления одного номера двум клиентам → ровно одно
  `added` (блокировка приёма); «не работает» у основного — основным становится следующий рабочий;
  «основной» у нерабочего → 400.
- `contacts.test.ts`: добавление, правка с событиями `obj:'contact'`, архив.
- `feed.test.ts`: события слитого клиента видны в ленте выжившего; курсор без пропусков и повторов
  при равных `at`; событие скрытого поля не приходит (и не занимает лимит); фильтр групп; вид не
  из реестра не приходит.
- `isolation.test.ts`: оператор A и объекты оператора B — `GET` карточки, ленты, `PATCH` клиента,
  `POST` номера и контакта, `PATCH` номера и контакта → 404 с телом, как у несуществующего id;
  снимок `clients`, `client_phones`, `contacts`, `client_events`, `phone_probes`, `tasks` не меняется;
  список A не содержит id B; поиск A по 3+ буквам названия B, 5+ цифрам номера B и БИН B — пусто;
  консультант вне окна → 404, в окне — чтение да, `PATCH` → 404 (нет `client.edit`); HTML страницы
  `/clients/[id]` объекта B у A — `notFound`, нет названия, номера и БИН B.
- `search.test.ts`: поиск по названию с «ТОО» и без, по казахским буквам, по номеру с 8 и +7, по
  БИН; значение поля, скрытого хоть одной роли, поиском не находится; больше 20 совпадений → 20.

**8.3. Манифест** `tests/isolation/manifest/clients.ts`:

| kind | path | method | perm | target | idParam | mutation, touches |
|---|---|---|---|---|---|---|
| route | `/api/clients` | GET | `client.read` | section | — | нет |
| route | `/api/clients/[id]` | GET | `client.read` | object | `id`: client | нет |
| route | `/api/clients/[id]` | PATCH | `client.edit` | object | `id`: client | да: `clients`, `client_events` |
| route | `/api/clients/[id]/feed` | GET | `client.read` | object | `id`: client | нет |
| route | `/api/clients/[id]/phones` | POST | `client.edit` | object | `id`: client | да: `client_phones`, `clients`, `client_events`, `phone_probes`, `tasks` |
| route | `/api/clients/[id]/contacts` | POST | `client.edit` | object | `id`: client | да: `contacts`, `client_events` |
| route | `/api/clients/phones/[id]` | PATCH | `client.edit` | object | `id`: client_phone | да: `client_phones`, `client_events`, `clients` |
| route | `/api/clients/contacts/[id]` | PATCH | `client.edit` | object | `id`: contact | да: `contacts`, `client_events` |
| page | `/(op)/clients` | GET | `client.read` | section | — | нет |
| page | `/(op)/clients/[id]` | GET | `client.read` | object | `id`: client | нет |

`sampleBody` — синтетика: номер `+7 709 555 01 01`, название «ТОО Пример», `opId` — фиксированный uuid.

**8.4. e2e** `tests/e2e/calling-client-card.spec.ts` (iPhone 13, Pixel 7): оператор открывает
карточку из списка → видит шапку и `tel:`-ссылку «Позвонить» → меняет поле → событие в ленте →
добавляет номер → номер в списке.

---

## 9. Что нужно от других

| Кому | Что | Зачем |
|---|---|---|
| координатор | `export * as fields from './fields';` в `packages/core/src/index.ts` и `'fields'` в `index.test.ts` | сервер импортирует только корень (D-101) |
| platform | `src/server/platform/hmac.ts`: `phoneHmac(digits): string` (HMAC-SHA256 hex, ключ `CRM_PHONE_HMAC_KEY`, в production без ключа — исключение; в тестах — ключ из окружения теста) | стоп-лист при добавлении номера (D-021); тем же пользуется C3 |
| platform | `INTAKE_LOCK_KEY` в `src/server/platform/db/locks.ts` | общая блокировка приёма (D-022) для C2 и C3 |
| platform | `'clients'` в `NAMESPACES` (`src/i18n/config.ts`) | файл `messages/ru/clients.json` |
| platform | прогон изоляции: в мир прогона — ревизия настроек с `global.fields` и `phone`, `security` (сейчас `configDoc()` даёт только роли); доменный код читает поля через `getActiveConfig()` | C2 падал бы `ConfigMissingError` в прогоне |
| platform | проверка целостности настроек: `reservedKeyIssues` (ключ поля = системный ключ объекта) и «поле `required.onOutcome` должно быть `edit` у ролей с `card.outcome`» | иначе обязательное поле невозможно заполнить (D-122) |
| manager | не создавать `(mgr)/clients/page.tsx` и `(mgr)/clients/[id]` — URL `/clients` и `/clients/[id]` заняты страницами `(op)` (две группы маршрутов на один URL роняют `next build`); РОП открывает ту же карточку, охват делает своё | конфликт маршрутов |
| booking (tasks) | показ задачи `source 'review'` с ключом `add_phone:` как «Проверить номер {title}» и действия РОП «Добавить номер клиенту» / «Отклонить» | разбор проверки номера (D-040) |
| platform (заметка) | `src/server/**` импортирует `@crm/core/config` и `@crm/core/access` подпутями; D-101 в production поддерживает только корень | проверить до сборки образа |

---

## 10. Разбивка работ

| № | Задача | Уровень | Кто | Зависит от |
|---|---|---|---|---|
| T1-a | Адаптер форм собственности `names/fromConfig.ts` + тест | T1 | builder | — |
| T1-b | `clients/config.ts`, `input.ts`, `types.ts`, unit-тесты схем и курсора | T1 | builder | корневой экспорт `fields` |
| T2→T1-c | `clients/repo.ts` (4.1–4.7), `service.ts`, `searchNorm.ts`, `phones.ts`, `contacts.ts` по разделам 4–5 | T2→T1 | builder; `reviewer` T2 (доступ, ПДн) | T1-b, `phoneHmac`, `INTAKE_LOCK_KEY` |
| T2→T1-d | `timeline/kinds.ts`, `timeline/repo.ts` (4.8–4.9), `timeline/index.ts` | T2→T1 | builder; `reviewer` T2 | T1-b |
| T1-e | Маршруты `src/app/api/clients/**` и манифест `clients.ts` | T1 | builder | c, d |
| T1-f | Страницы и `_ui/*` по разделу 7, `messages/ru/clients.json` | T1 | builder | e, NAMESPACES |
| T1-g | Интеграционные тесты 8.2 (включая `isolation.test.ts`) | T1 | tester | c–e |
| T1-h | e2e 8.4 | T1 | tester | f |
| T0-i | Проверка: в `src/`, `messages/` нет стоп-слов клиента; ключи локалей на месте | T0 | mechanic | f |
| T2 | Ревью всего диффа перед влитием (доступ, `phoneTakenElsewhere`, ПДн в ленте) | T2 | reviewer | всё |
