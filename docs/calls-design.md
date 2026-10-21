# Итоги звонка, пропуски, очередь «Звонить» — дизайн C5 для builder

Статус: дизайн architect, 22.10.2026. Нормативно: PROCESS §2.5–2.6, §3, §7.4, §12.1–12.10, §12.25,
§12.31–12.32; ARCHITECTURE §7; D-019, D-037, D-050, D-063, D-133, D-145; решения **D-175…D-178**.
Контракты (готовы, менять — через architect): `src/server/domain/cards/types.ts`,
`src/server/domain/calls/types.ts`, `src/server/domain/tasks/types.ts`. Ядро — только корень
`import { calling, fields, time } from '@crm/core'`; машина состояний — `calling.applyOutcome`
(спецификация `packages/core/src/calling/spec/README.md`, её не правим). Next 16: перед маршрутами прочитай
`node_modules/next/dist/docs/`. Все примеры — синтетика (+7 709 …).

## 1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/cards/settings.ts` | `loadCallingContext`: Zod-срез `calling.*`, `queue.*`, `reasons`, `distribution.capIncludes`, `booking.noShow/nextStep/attendance`, `tasks.*`, календарь → `CallingContext` (как `booking/settings.ts`). **Первым**: его ждут порт для записи и тесты |
| `cards/repo.ts` | SQL карточки: блокировка с охватом и без, снимок с номерами, `wasOwnerAt`, запись карточки по версии, номера, поля шторки, уведомления, лента, стоп-лист, журнал раздачи, пропуски, руководитель, сверка |
| `cards/persist.ts` | `persistTransition` (§4.4) |
| `cards/effects.ts` | `applyCardEffects` (§5) и `resolveLead` |
| `cards/actor.ts` | `toCoreActor(actor)` (§3) |
| `cards/bookingPort.ts` | `createCardBookingPort` + `cardBookingPort` (§9) — **сразу после persist**, его ждёт B2 |
| `cards/invariants.ts` | `countOwnerlessWorkingCards` (часть ночной сверки, D-066) |
| `cards/index.ts` | экспорты |
| `src/server/domain/tasks/auto.ts` | автозадачи D-050 по `tasks/types.ts` (§6) |
| `src/server/domain/calls/{outcomes,skips,queue,device,errors,deps,repo,index}.ts` | итог §4, пропуск §7, очередь §8, устройство §10 |
| `src/server/domain/timeline/kinds.ts` | виды ленты ядра (§5) |
| `src/server/platform/audit.ts` | + сущность `card`, действия `card.dnc_cleared`, `card.merged` (строки модуля) |
| `src/app/api/calls/{outcomes,skips,queue}/route.ts`, `src/app/api/calls/_lib.ts` | маршруты §11 |
| `messages/ru/calls.json` + `NAMESPACES` | коды ошибок и подписи шторки |
| `tests/isolation/manifest/calls.ts` | маршруты §11 |

## 2. Модель (что уже есть в схеме v1)

- `calls.id = opId` (PK) — идемпотентность итога; `skips.id = opId` — пропуска.
- `cards.version` растёт на каждое изменение; итог версию **не сравнивает** (12.4), порядок итогов — по
  `occurred_at` против `last_outcome_at` (12.1); ручные действия сравнивают `seenVersion`.
- `cards.next_call_at` — источник правды перезвона и повтора (D-050); задача — проекция.
- `stop_list.phone_hmac` = `phoneHmac(digits)` (`src/server/platform/hmac.ts`); открытый номер туда не идёт.
- `device_status (user_id, device_id)` — счётчик неотправленных (D-063).
- Миграция **не нужна**: все коды итогов, источники задач, виды журнала и `fact_reason` в схеме есть.

## 3. Снимок, блокировка, исполнитель

- `lockCardScoped(tx, viewer, cardId, 'card.outcome')`:
  `SELECT … FROM cards c WHERE c.id = $id AND ${scopeSql(viewer, 'card', 'card.outcome')} FOR UPDATE OF c`,
  затем номера клиента (без блокировки):
  ```sql
  SELECT p.id, p.digits, p.kind, p.is_working, p.is_primary,
         EXISTS (SELECT 1 FROM client_phones o JOIN clients oc ON oc.id = o.client_id AND oc.merged_into_id IS NULL
                  WHERE o.digits = p.digits AND o.client_id <> p.client_id) AS shared_with_other_client,
         EXISTS (SELECT 1 FROM client_phones o JOIN cards ok ON ok.client_id = o.client_id
                  WHERE o.digits = p.digits AND o.client_id <> p.client_id
                    AND ok.space_id = $space AND ok.state = 'do_not_call') AS held_by_other_dnc_client
    FROM client_phones p WHERE p.client_id = $client
   ORDER BY p.is_primary DESC, (p.kind = 'mobile') DESC, p.created_at, p.id;
  ```
  `inStopList` — `SELECT phone_hmac FROM stop_list WHERE phone_hmac = ANY($hmacs)` по HMAC цифр в коде.
- `lockCardUnscoped` — тот же запрос без `scopeSql` (только пути из шапки `cards/types.ts`).
- `wasOwnerAt` (D-175):
  `SELECT to_user_id FROM assign_log WHERE card_id = $c AND created_at <= $t ORDER BY created_at DESC, id DESC LIMIT 1`
  → `to_user_id = $me`. Строк нет → false.
- `toCoreActor`: Viewer → `{ userId, kind: 'user', scope }`, где `scopeOf(v, 'card.outcome')`: `own` → `own`;
  `team`/`space`/`all` → `space`; нет → `relation`. SystemActor → `{ userId: null, kind: 'system', scope: 'space' }`.
  Ветка итога без охвата (карточку передали, §4.2) заменяет `space` на `own`: ядро превращает итог в
  `fact_only owner_changed` только при `own`, а `team` без замены применил бы итог к карточке вне охвата (D-224).

## 4. Итог: `POST /api/calls/outcomes` → `submitOutcome`

### 4.1. До транзакции

1. Zod `.strict()` по `OutcomeRequest`: `opId` uuid; `occurredAt`, `callbackAt`, `tappedAt`, `agreedDueAt` —
   целые ≥ 0; `note` ≤ 2000; `lprInfo` поля ≤ 200; `alsoDncPhoneIds` ≤ 10; `fields` ≤ 20 ключей.
2. `receivedAt = deps.now()`; `ctx = deps.context(viewer.spaceId, receivedAt)`; нет пространства → 404.
3. `fields`: ключи ⊆ `requiredFields` итога, иначе 400 `field_not_allowed`; значения — движок полей K2
   (`fields.buildFieldValidator`, режим правки, доступ поля для роли зрителя), ошибки → 400 `fields`.
4. Вид итога `do_not_call` или `bad_number` без `phoneId` → 400 `phone_required` (стоп-лист — по номеру
   разговора, D-175).

### 4.2. Транзакция (повтор при 40P01/40001 до 3 раз, как `booking/tx.ts`)

```
SET LOCAL lock_timeout = '5s'
t = clamp(occurredAt, receivedAt − offlineWindowHours·ч, receivedAt + 5 мин)
row = lockCardScoped(tx, viewer, cardId, 'card.outcome'); wasOwner = false
если row = null:
   свой prior (user_id = viewer и card_id = cardId) → ответ duplicate, card: null       -- D-223, до проверки владения
   !wasEverAssignedTo(cardId, viewer) → 404                                  -- чужие карточки не блокируем
   row = lockCardUnscoped(tx, viewer, cardId); нет или другое пространство → 404
   свой prior (появился, пока ждали блокировку) → ответ duplicate, card: null
   !wasOwnerAt(cardId, viewer, t) → 404                                      -- чужое = несуществующее
   wasOwner = true                                                           -- ядро даст fact_only owner_changed
prior = SELECT applied, fact_reason, user_id, card_id FROM calls WHERE id = $opId   -- после блокировки!
если prior: user_id ≠ viewer или card_id ≠ cardId → 404; иначе → ответ duplicate (§4.5)
actor = toCoreActor(viewer); wasOwner и actor.scope = space → actor.scope = own  -- D-224: вне охвата только факт
phoneId и alsoDncPhoneIds ∉ номера карточки → 400 phone_not_on_card
event = OutcomeEvent { …req, receivedAt, occurredAt: req.occurredAt (ядро само ограничит и предупредит),
                       hasNote: note.trim() ≠ '', lprInfoFilled: любое поле lprInfo не пусто,
                       seenVersion: null, facts: { sameOpId: null, actorWasOwnerAtCall: wasOwner } }
-- «Договорились — записать» (§4.3) меняет здесь event.agreement.bookingId
result = calling.applyOutcome({ card: row.snapshot, event, actor, now: receivedAt,
                                settings: ctx.settings, calendar: ctx.calendar })
rejected → throw CallsDomainError(error, field)       -- откат всего, включая запись
applied | fact_only → persistTransition(tx, viewer, { ctx, before: row, result, call: extras, at: receivedAt })
applied и fields не пусто → поля в client.custom / card.custom (K2 → UPDATE с scopeSql 'card.edit'
   или 'client.edit' по объекту поля) + лента `field.changed`
```

`extras`: `note`, `fieldsPatch = { ...fields, lpr: lprInfo }` (pii, только в `calls.fields_patch`),
`tappedAt`, `durationSec`, `durationSource = durationSec !== null ? 'manual_estimate' : 'none'`.

### 4.3. «Договорились — записать» (D-019, PROCESS 12.7)

Ядро решает, будет ли итог применён, а запись должна появиться только при применении. Поэтому:
1. первый вызов `applyOutcome` с `agreement.bookingId = '__pending__'`;
2. `applied` → `createBooking(deps.booking(), viewer, { ...req.agreement.booking, requestId: opId, clientId:
   row.snapshot.clientId, contactId: req.agreement.contactId }, { tx, fromOutcome: { opId } })`; ошибка записи
   (`event_full` с альтернативами и др.) — откат всего, ответ — как у маршрутов записи (409 + тело);
3. второй вызов `applyOutcome` с настоящим `bookingId` → `persistTransition`. Эффект `ensure_open` найдёт
   сделку, которую открыла запись (`request_id = opId`, D-134);
4. `fact_only` (передали, устарел) → запись не создаём, ответ `fact_only`, `bookingId: null` (интерфейс
   говорит «Карточка передана. Итог сохранён в истории», PROCESS 12.5).

Порядок блокировок совпадает с B2: карточка (здесь) → мероприятие → записи (createBooking).

### 4.4. `persistTransition` (cards/persist.ts)

1. `result.call` есть → `INSERT INTO calls (id, space_id, card_id, client_id, user_id, owner_user_id_at_call,
   direction, via, phone_digits, outcome_code, outcome_kind, reason_code, note, lpr, callback_at,
   fields_patch, applied, fact_reason, tapped_at, occurred_at, received_at, duration_sec, duration_source,
   config_rev) … ON CONFLICT (id) DO NOTHING RETURNING id`; 0 строк → исключение `duplicate_race` (под
   блокировкой карточки так не бывает; вызывающий откатит и повторит — повтор ответит `duplicate`).
   `phone_digits` = цифры `phoneId` из `row.phoneDigits` или `''`. `occurred_at` — из `result.call` (уже ограничено).
2. `result.card.version ≠ before.version` → `UPDATE cards SET <все изменяемые колонки из result.card>,
   updated_at = $at WHERE id = $id AND version = $before RETURNING id`; 0 строк → исключение.
3. Номера: для каждого номера, где `isWorking`/`isPrimary` изменились, — сначала снять основной
   (`is_primary = FALSE`), затем поставить новый (уникальный индекс `client_phones_one_primary`).
4. `applyCardEffects(tx, actor, effectCard(после), result.effects, at, ctx)`.

### 4.5. Ответ

`200 OutcomeResponse`: `status` и `applied`/`factReason` из результата; `warnings`
(`callback_outside_work_hours`, `occurred_at_clamped`); `card` = `{ id, state, version, nextCallAt }` из
`result.card`, **null** при `owner_changed` (карточка оператору больше не видна). Повтор (`duplicate`):
`applied`/`factReason` прежней строки, `card` — текущее состояние, если карточка видна (`scopeSql`), иначе null.

## 5. Исполнитель эффектов (`cards/effects.ts`)

Порядок групп: `tasks` → `deals` → `bookings` → `stopList` → `assignLog` → `notifications` → `timeline` →
`audit` → `skips`; внутри группы — порядок ядра.

| Эффект | Что делает |
|---|---|
| `tasks.create` | получатель: `{ user }` или `resolveLead` (D-176); `ensureAutoTask` (`title = ''`, `created_by` = автор или NULL) |
| `tasks.close` / `close_by_key` / `reassign_open` | `closeAutoTasks` / `closeAutoTaskByKey` / `reassignOpenTasks` |
| `deals.*` | `applyDealEffects(tx, actor, card, effects, at)` (deals/effects.ts). `lose_open` закрывает проигрышем с причиной итога **все открытые сделки клиента в пространстве** (PROCESS 4.1), каждой — `deal.lost` в ленте; открытых нет — ничего. `lose`, `win`, `cancel_purchase`, `reassign_open` пока бросают (B6/B9a) |
| `bookings.*` | `applyBookingEffects(tx, actor, card, effects, at)` (booking/effects.ts) |
| `stopList.add` | `INSERT INTO stop_list (phone_hmac, reason_code, source 'outcome', created_by, created_at) ON CONFLICT DO NOTHING` |
| `stopList.remove` | `DELETE FROM stop_list WHERE phone_hmac = $h` |
| `assignLog` | `INSERT INTO assign_log` (`day` = местные сутки `at`, `run_id = opId`, `actor_id`) |
| `notifications` | получатель как у задач; `INSERT INTO notifications (…, kind, params '{}', dedupe_key, not_before = at) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING` |
| `timeline` | `INSERT INTO client_events (…, kind, actor_id, at, ref_type, ref_id, data)`; у `call` в `data` добавить `outcome` (код итога) и `phoneId` |
| `audit` | `writeAudit`: `dnc.cleared` → `card.dnc_cleared`, `card.merged` → `card.merged`; entity `card` |
| `skips` | `INSERT INTO skips (id = opId, space_id, user_id, card_id, day, created_at) ON CONFLICT (id) DO NOTHING` |

`timeline/kinds.ts`: добавить виды ядра `card.created`, `card.assigned`, `card.released`, `card.transferred`,
`card.acting`, `card.merged`, `card.state`, `dnc.set`, `dnc.cleared` (группа `system`, ключи данных — как
выдаёт ядро) и расширить `call`: `outcome`, `outcomeKind`, `fromState`, `toState`, `factReason`, `phoneId`,
`durationSec`. Раздача (C6a) пишет `card.assigned` — регистрация здесь, у владельца ленты.

## 6. Автозадачи (`tasks/auto.ts`, D-050)

- `ensureAutoTask`: `INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at,
  assignee_user_id, status, source_key, created_by, created_at) VALUES (…, '', …, 'open', …)
  ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND status = 'open' DO NOTHING RETURNING id`;
  нет строки → `SELECT id FROM tasks WHERE source_key = $k AND status = 'open'` → `created: false`.
- `closeAutoTasks`: `UPDATE tasks SET status = 'done', done_at = $at WHERE space_id = $s AND client_id = $c
  AND status = 'open' [AND source = ANY($sources)]`.
- `closeAutoTaskByKey`: по `source_key` среди открытых.
- `reassignOpenTasks`: `assignee_user_id = $to` у открытых задач клиента в пространстве.
- `listMyOpenTasks`: `scopeSql(viewer, 'task', 'task.read')` + `assignee_user_id = viewer`, `ORDER BY due_at
  NULLS LAST, created_at` — для C7c «Мои перезвоны» и колокола.

## 7. Пропуск: `POST /api/calls/skips` → `submitSkip`

```
tx: SET LOCAL lock_timeout = '5s'; pg_advisory_xact_lock(SKIP_LOCK_CLASS, hashtext(viewer.userId))
  prior = SELECT user_id, card_id FROM skips WHERE id = $opId → чужой → 404; свой → duplicate
  row = lockCardScoped(tx, viewer, cardId, 'card.outcome') → null → 404
  skipsToday = SELECT count(*) FROM skips WHERE user_id = $me AND day = $today      -- skips_day_idx
  result = applyOutcome({ type: 'skip', opId, facts: { skipsToday } })
  rejected: skip_limit → 409 { error: 'skip_limit', skipLimit }; invalid_transition → 409; not_found → 404
  applied → applyCardEffects(… effects.skips …)   -- карточка не меняется
→ { status, skipsToday: skipsToday + 1, skipLimit }
```

Блокировка пропусков берётся **до** карточки; итог её не берёт — цикла нет. 12 одновременных пропусков при
лимите 10 → ровно 10 (интеграционный тест).

## 8. Очередь «Звонить»: `GET /api/calls/queue` → `getQueue` (D-177)

Свои карточки = `owner_user_id = me OR acting_user_id = me` (временный владелец ведёт карточку как свою,
PROCESS 7.5) плюс `scopeSql(viewer, 'card', 'card.outcome')`. Порядок групп — `queue.order`
(по умолчанию перезвоны → повторы → возвращённые → новые); пропущенные сегодня — в конце очереди.

```sql
WITH mine AS (
  SELECT c.id, c.client_id, c.state, c.version, c.attempts, c.next_call_at, c.assigned_at, c.created_at,
         c.last_outcome_code, c.last_outcome_at, c.lpr, c.is_target
    FROM cards c
   WHERE c.space_id = $space AND (c.owner_user_id = $me OR c.acting_user_id = $me)
     AND c.hold_reason = '' AND c.state IN ('new','retry','callback')
     AND (c.state = 'new' OR c.next_call_at <= $now)
     AND NOT (c.id = ANY($exclude)) AND ${scopeSql(viewer, 'card', 'card.outcome')}),
skipped AS (SELECT card_id, max(created_at) AS at FROM skips WHERE user_id = $me AND day = $today GROUP BY card_id)
SELECT m.*, s.at AS skipped_at,
       (m.state = 'new' AND EXISTS (SELECT 1 FROM client_phones p
           WHERE p.client_id = m.client_id AND p.is_working AND p.kind = 'mobile')) AS has_mobile
  FROM mine m LEFT JOIN skipped s ON s.card_id = m.id
 ORDER BY (s.at IS NOT NULL), s.at,
          array_position($order::text[], CASE m.state WHEN 'callback' THEN 'callbacks'
                                                       WHEN 'retry' THEN 'retries' ELSE 'new' END),
          m.next_call_at NULLS LAST, has_mobile DESC /* только при queue.mobileFirst */,
          m.assigned_at NULLS LAST, m.created_at, m.id
 LIMIT $limit;
```

- Группа «возвращённые» до C6c пуста (возврат делает карточку `callback` сейчас, она идёт в перезвоны).
- Счётчики — один запрос по тому же `mine` без `LIMIT`: `count(*) FILTER` по группам, `overdue` =
  перезвоны с `next_call_at < now − overdueAlertMinutes`, `skippedToday`; плюс `skipLimit` из настроек.
- По отобранным (≤ 4) карточкам: название клиента, номера (рабочие, не из стоп-листа по HMAC; цифры
  полностью — для `tel:` своей карточки), поля по правам `fields.projectFor` (как карточка клиента C2).
- `decisionMaker` — ЛПР клиента (имя, должность, телефон контакта с `is_decision_maker`), `lastNote` — свежайшая
  заметка из `notes` и заметок итогов звонков, до 300 символов. Читаются тремя-четырьмя запросами на страницу
  (по отобранным карточкам), без N+1.
- `GET /api/calls/today` → `getToday`: итоги, дозвоны, записи и пропуски сотрудника за местные сутки пространства
  (по всем его устройствам); экран складывает серверные числа с итогами, ещё лежащими в outbox.
- `limit` 1–4 (по умолчанию 1), `exclude` ≤ 50 id (итоги в outbox устройства), `group` — вкладки
  «Все / Перезвоны / Повторы / Новые».
- p95 ≤ 300 мс на 5 000 карточек (10 операторов × 500): индексы v1 `cards_queue_idx`, `cards_acting_idx`,
  `skips_day_idx`; у оператора в работе сотни строк, сортировка в памяти. Миграция не нужна.

## 9. Порт для записи (`cards/bookingPort.ts`, контракт booking-design §7.1)

`createCardBookingPort(load)` → `applyBookingEvent(tx, actor, card: LockedCard, event, now)`:
снимок по `card.id` **без** повторной блокировки и без охвата (booking уже заблокировал и проверил) →
`ctx = load(card.spaceId, now)` → `calling.applyOutcome({ card, event, actor: toCoreActor(actor), now,
settings, calendar })` → `applied`/`fact_only` → `persistTransition` (без `call`) → вернуть результат как есть
(`rejected` не бросать: решает booking). Замена `cards` в `src/server/domain/booking/deps.ts` — одна строка,
координатор (booking-design §12). Тест: `tests/integration/booking/*` проходят с настоящим портом
(`no_show` → `callback` + задача `no_show:<bookingId>`; `attended` → сделка `advance`).

## 10. Устройство (D-063, D-178)

`parseDeviceHeaders(req.headers)`: `X-Device-Id` (1–64 `[A-Za-z0-9_-]`), `X-Outbox-Pending` (0–10 000),
`X-Outbox-Last-Flush` (epoch-мс или пусто); мусор → null. Маршруты calls после основной работы вызывают
`recordDeviceStatus` (ошибка — только в лог, ответ не меняется):

```sql
INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at)
VALUES ($me, $dev, $pending, $lastFlush, $now)
ON CONFLICT (user_id, device_id) DO UPDATE
   SET pending_outbox = EXCLUDED.pending_outbox,
       last_flush_at = COALESCE(EXCLUDED.last_flush_at, device_status.last_flush_at),
       seen_at = EXCLUDED.seen_at
 WHERE device_status.seen_at <= EXCLUDED.seen_at;
```

Пинг `POST /api/device/ping` (сделан в ops, волна B; право `authenticated`) зовёт ту же `recordDeviceStatus` из домена calls.
`purgeDeviceStatus(actor, before)` — для `purge` воркера (§12).

## 11. API (route handlers через `route()`)

| Метод и путь | Разрешение, `target` | Тело / запрос | Ответ |
|---|---|---|---|
| `POST /api/calls/outcomes` | `card.outcome`, object | `OutcomeRequest` (≤ 16 КБ) | 200 `OutcomeResponse` |
| `POST /api/calls/skips` | `card.outcome`, object | `{ opId, cardId }` | 200 `SkipResponse` |
| `GET /api/calls/queue` | `card.outcome`, section | `limit`, `exclude` (через запятую), `group` | 200 `QueueResponse` |

Ошибки (`calls/errors.ts` + `respond()` как в `src/app/api/bookings/_lib.ts`):

| Код | HTTP | Тело | Что делает outbox устройства (C7b) |
|---|---|---|---|
| `not_found`, `opid_reused` | 404 | `{ error: 'not_found' }` (как у несуществующего) | убрать из outbox, показать «итог не принят» |
| проверки ядра (`reason_required`, `lpr_required`, `lpr_info_required`, `callback_at_required`, `callback_in_past`, `contact_required`, `agreement_required`, `phone_required`, `outcome_unknown`, `outcome_archived`) и `field_not_allowed`, `phone_not_on_card`, `fields` | 400 | `{ error: 'bad_request', code, field }` | то же |
| `wrong_user` (D-291): `X-Call-Author` не совпал с сессией; проверка до разбора тела, ничего не пишется, `device_status` тоже | 409 | `{ error: 'wrong_user', code: 'wrong_user' }` | **оставить** без названия компании, из этой вкладки не слать; уходит при входе автора |
| `skip_limit`, `invalid_transition` | 409 | `{ error: code, skipLimit? }` | — (пропуск онлайн) |
| ошибки записи (`event_full` …) | как у B2 | тело B2 | шторка показывает альтернативы |
| `forbidden` (охват `relation`) | 403 | — | убрать |
| лицензия «только чтение» | 423 (обёртка) | — | **оставить** и повторять |
| 5xx, сеть | — | — | оставить и повторять |

Автор (D-291, D-292). Экран «Звонить» шлёт `X-Call-Author` во всех записях: итог из outbox — с `userId` записи outbox,
пропуск и «Договорились — записать» — с сотрудником страницы. Чтения `GET /api/calls/queue` и `/today` несут его с
сотрудником страницы; не совпал с сессией — 409 `wrong_user` до чтения, `device_status` не пишется, страница
прячется и перезагружается. Нет заголовка — запрос от сессии как есть (скрипты,
интеграции). Повтор того же `opId` тем же автором — обычный `duplicate`.

### 11.1. Общий телефон: выход и смена сотрудника (D-063, D-291, ARCHITECTURE §7)

- **Выход.** `finishLogout`: флаг `crm.logout.pending` в localStorage (без ПДн) и кэш-метка `crm-logout-pending` для
  service worker → очистка телефона (`purgeDevice`) и кэша оболочки → `POST /api/auth/logout`. Сервер ответил (2xx
  или 401) — флаг и метка сняты, переход на вход. Нет сети — на вход не уходим.
- **Пока флаг стоит**: скрипт в `<head>` корневого layout ставит `data-logout-pending` на `<html>` до первой
  отрисовки, CSS прячет всё, кроме экрана блокировки «Выход завершится, когда появится сеть» (`LogoutGuard`, на
  любой странице, включая вход). Повтор выхода — на `online` и раз в 5 с. `CallScreen` не грузит очередь, не шлёт
  outbox и не пишет черновик; другие вкладки узнают о флаге по событию `storage`. Service worker при метке не отдаёт
  и не кэширует оболочку `/call` (версия кэша `crm-shell-v3`: оболочки без скрипта удалены).
- **Смена сотрудника без выхода** (сессия A истекла, вошёл B): при загрузке страницы под B (`DeviceOwnerGuard` в
  оболочке и старт `CallScreen`) черновик, «намерение звонка», счётчик за сутки и отказы сервера других сотрудников
  удаляются; их неотправленные итоги остаются только с id и кодами запроса (`title = ''`) и уходят только под A.
- **Вторая вкладка прежнего сотрудника** (D-292): метка `crm.device.owner` (id сотрудника страницы, пришедшей с
  сервера; ставят `DeviceOwnerGuard` и старт `CallScreen`). Вкладка сверяет её на `storage`, `visibilitychange`,
  `focus`, `pageshow`, а на возврат ещё и спрашивает сервер (`/today`, 409 `wrong_user`). Не совпало — атрибут
  `data-owner-changed` прячет страницу, `CallScreen` блокируется (ничего не пишет и не шлёт), перезагрузка.
- **Выход с итогами со свободным текстом** (D-293): `flushDeviceOutbox` возвращает `{ count, freeText }`;
  `freeText` — записи outbox с признаком `freeText` (ставит экран при постановке итога по видам полей из настроек;
  у старых записей — проверка с запасом, `freeText.ts`). При `freeText > 0` кнопки «Всё равно выйти» нет: «Остаться»
  или «Удалить их и выйти» с подтверждением; `finishLogout` без подтверждения отвечает `confirm`, с подтверждением
  `purgeDevice` удаляет такие записи целиком.
- **Вкладка не воскрешает названия**: повтор (`later`) и отказ берут запись из хранилища, а не из памяти вкладки;
  записи в хранилище нет — её не возвращают.

## 12. Тесты

**Unit** (`tests/unit/calls/*`, `tests/unit/cards/*`): `loadCallingContext` на пресете `base` и накладке ЦРП
(все `calling.*` из настроек, без констант компании); `toCoreActor`; разбор заголовков устройства;
Zod-тело итога (лишние поля → 400); исполнитель эффектов на поддельном `tx` — порядок групп и
разрешение `{ role: 'lead' }`.

**Интеграционные** (`tests/integration/calls/*`, Postgres 16, сид изоляции `tests/isolation/harness/seed.ts`):
- идемпотентность: один `opId` дважды подряд и параллельно (`Promise.all`) → одна строка `calls`, второй
  ответ `duplicate` с тем же `applied`; лента и задачи не задвоены;
- `fact_only owner_changed`: карточку передали (assign_log `transfer` → B) после звонка A → итог A пишется
  фактом, состояние не меняется, задача B `review:<opId>`, ответ `card: null`; звонок после передачи → 404;
  то же для роли с охватом `team`, когда карточка ушла в другую команду: факт, сделки открыты (D-224);
  свой повтор `opId` после передачи и позже окна офлайна → `duplicate`, `card: null` (D-223);
- `stale`: итог с `occurredAt` раньше `last_outcome_at` → факт, состояние прежнее; офлайн-итог 3 ч назад →
  `retry` от времени звонка (12.3); `occurredAt` +10 мин в будущем → ограничен, предупреждение;
- гонка двух итогов по одной карточке (владелец и временный владелец, 20 прогонов): побеждает поздний по
  `occurred_at` при любом порядке прихода, второй — `fact_only stale`;
- «Не берёт» ×3 → `written_off no_answer_limit`; `retry.steps` из настроек; повтор вне окна → следующий
  рабочий день 10:00 (26.10.2026 пропущен);
- «Номер не работает»: второй рабочий номер → `retry` сейчас, основной сменился, попытки те же; номера нет →
  `written_off no_working_phone`; лента `phone.not_working`, `phone.primary`;
- «Просил не звонить»: номер разговора и отмеченные → `stop_list` (HMAC, `source = 'outcome'`), общий номер с
  другим клиентом → не в стоп-лист, задача руководителю `dnc_confirm:…`; будущие записи отменены
  `do_not_call`; без `phoneId` → 400;
- «Перезвонить»: `next_call_at`, задача `callback:<opId>`; перенос → старая задача закрыта, новая создана;
  в прошлое раньше `t − 5 мин` → 400 `callback_in_past`;
- «Договорились — записать»: итог + запись + сделка одной транзакцией; последнее место занято → 409, нет ни
  строки `calls`, ни записи; повтор того же `opId` после успеха → `duplicate`, вторая запись не создана;
  по переданной карточке → `fact_only`, записи нет;
- архивный итог: принят до `archivedAt + 72 ч`, после → 400 `outcome_archived`;
- пропуски: 12 параллельных при лимите 10 → 10 строк; повтор `opId` не считается дважды; пропущенная
  карточка в очереди в конце;
- очередь: порядок групп по `queue.order`; будущие перезвоны не видны; `exclude`; временный владелец видит
  карточку отсутствующего; карточки B в очереди A никогда; замер: 5 000 карточек, 30 запросов, p95 ≤ 300 мс
  (`queue-perf.test.ts`);
- устройство: заголовки → строка `device_status`; старый запрос после нового не перетирает; без заголовков —
  ничего;
- порт для записи: тесты B2 зелёные с `cardBookingPort`.

**Изоляция** (`tests/isolation/manifest/calls.ts`): A шлёт итог и пропуск по карточке B → 404, снимок таблиц
не меняется (`calls`, `cards`, `skips`, `tasks`, `client_events`, `stop_list`); `opId` существующего звонка B
от A → 404 без признаков чужой строки; очередь A не содержит карточек B и их номеров в JSON; директор → 423 на
`POST`; консультант (охват `relation`) → 403/404. Правило «после передачи у A сразу 404» — Q1a.

## 13. Нужно от других

| Что | Кто | Когда |
|---|---|---|
| ~~`lose_open`~~ сделано (сведение дня 3): все открытые сделки клиента в пространстве → `lost` с причиной итога. Осталось `reassign_open` в `deals/effects.applyDealEffects` | booking (B6) | до пилота |
| замена `cards` в `booking/deps.ts` на `cardBookingPort` | координатор | при влитии C5 |
| строки в реестре воркера: `countOwnerlessWorkingCards` (`invariants`), `purgeDeviceStatus` (`purge`) | координатор после P7 | 23.10 |
| ~~`POST /api/device/ping` → `recordDeviceStatus`~~ сделано в ops (волна B) | ops | — |

## 14. Чего builder C5 НЕ делает

Не делает экран «Звонить» и шторку (C7a), outbox и service worker (C7b), «Мои перезвоны» (C7c), закрытие из
меню, «Вернуть в обзвон», снятие «Не звонить», передачу и слияние как маршруты (C8/B9), `manual_entry` РОП,
телефонию; не правит `packages/core/src/calling/**` (векторы — источник правды), схему, `deals/**`,
`booking/**` (кроме чтения типов) и реестр воркера.

## 15. Разбивка работ

| № | Задача | Уровень | Кто |
|---|---|---|---|
| 1 | `calls/errors.ts`, `deps.ts`, `index.ts`, `messages/ru/calls.json`, NAMESPACES, строки аудита, виды ленты | T0 | mechanic |
| 2 | `cards/settings.ts` + unit; `cards/repo.ts`, `actor.ts`, `persist.ts`, `effects.ts`, `tasks/auto.ts` | T1 (по дизайну T2→T1) | builder |
| 3 | `cards/bookingPort.ts` + прогон тестов B2 с портом — **к 13:00** | T1 | builder |
| 4 | `calls/outcomes.ts`, `skips.ts`, `device.ts`, маршруты, интеграционные §12 | T1 | builder |
| 5 | `calls/queue.ts`, маршрут, замер | T1 | builder |
| 6 | манифест и изоляция | T1 | tester |
| 7 | ревью блокировок, идемпотентности, охвата и `fact_only` | T2 | reviewer |
