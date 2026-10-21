# Дежурство, консультации, сделки и передачи — дизайн B4, B4b, B5, B6, B6b для builder

Нормативно: решения D-241…D-250 (`docs/DECISIONS.md`). Опирается на PROCESS §2.7–2.8, §3.5 (№ 16–21, 28,
29, 31), §4.1–4.5, §5.2–5.6, §6.2, §8.1–8.4, §11, §12.17, 12.27–12.30, 12.40; ARCHITECTURE §5–6; CONFIG §6.8–6.9;
D-040, D-049, D-072, D-131…D-137, D-176, D-201…D-205; дизайны `booking-design.md` (B2) и
`booking-wizard-design.md` (B3a). Ядро — только корень `@crm/core` (`booking`, `calling`, `time`, `fields`,
`names`, `phone`). Перед кодом страниц и маршрутов — `node_modules/next/dist/docs/` (Next 16: `params` —
`Promise`, его читает обёртка).

**Сигнатуры уже в коде** (builder реализует, не меняет; правка — через architect):

| Файл | Что |
|---|---|
| `src/server/domain/booking/dutyTypes.ts` | B4 (дежурство, «Остальные не пришли», гость без записи), B4b (сверка) |
| `src/server/domain/booking/consultTypes.ts` | B5 (консультанты, график, день, подбор, назначение, «серые», «Мои консультации», итог БК) |
| `src/server/domain/deals/types.ts` | B6 (покупка, правка и отмена покупки, этап, проигрыш, «залежалась») |
| `src/server/domain/handoffs/types.ts` | B6 (создание передачи), B6b (входящие: принять, отклонить, назначить) |

Синтетика во всех тестах: номера `+7 709 …`, выдуманные имена. Схема v1 **не меняется**, миграций нет (§11).

---

## 0. Состав, флаги, сроки

| Задача | Что | Флаг | Срок | Где в PLAN |
|---|---|---|---|---|
| **B4** | экран «Дежурство», явка и исправление, «Остальные не пришли», гость без записи, мероприятия РОП (дежурные) | — (не режется, PLAN §6.3) | влить к **26.10 12:00** (`0.9.0`); крайний — `0.9.1` 27.10 | пилот §6.1 («к 28.10») |
| **B5a** | консультанты: список, создать, править, выключить (без графика) | — | к **26.10 12:00**: на установке 26.10 РОП заводит консультантов, 28.10 назначает их на заявки (B3b) | пилот §6.1 |
| **B5b** | график и исключения, снимок дня под блокировкой, запись к консультанту с подбором, пул «серых», назначение и резерв, `grey-assign` | `FEATURE_BK_WIZARD` | 27.10 | релиз §6.2 |
| **B5c** | «Мои консультации», итог БК, запись клиента к себе; экраны графика | `FEATURE_BK_WIZARD` | 27.10 | релиз §6.2 |
| **B4b** | `attendance-sweep`, инвариант «Договорились», закрытие «Отметьте явку», «залежалась» | — (выключатель — `autoNoShowWorkdays: null`, D-243) | 28.10 | релиз §6.2 |
| **B6** | покупка, правка и отмена покупки, этап и проигрыш, передача в отдел, страницы сделки и покупки | `FEATURE_PURCHASES` | 28.10 | релиз §6.2 |
| **B6b** | входящие передачи главы отдела и исполнителя | `FEATURE_PURCHASES` | 29.10 | релиз §6.2 |

Флаг выключен → маршруты и страницы модуля отвечают 404 (`NotFoundError`), пункты меню скрыты. Минимальная
заявка на БК B3a и ручное назначение B3b работают без флага (D-203).

## 1. Общие правила модулей

- **SQL — только в `repo.ts`** своего модуля, первый аргумент — исполнитель; строки клиентов, карточек,
  записей, сделок, задач, передач — через `scoped(sql)` + `scopeSql`. Исключения перечислены явно (§2.6 поиск
  номера гостя, §4.9 своё расписание консультанта, §5.4–5.6 запись покупки, её отмены и передачи по сделке, уже
  взятой `FOR UPDATE` в охвате действия или исполнителем эффектов, D-302) и записаны в решениях.
- **Порядок блокировок** — единый порядок D-251 (`tasks-team-design.md` §1.2): приём (`INTAKE_LOCK_KEY`) →
  клиенты → **карточки по возрастанию `id` → мероприятие или блокировка дня консультаций (D-245) → записи →
  сделки → передача → задачи**. Блокировка приёма — только у нового гостя (§2.6). Транзакция, берущая advisory,
  первой командой ставит `SET LOCAL lock_timeout = '10s'`. Повтор `40P01`/`40001` — только во внешней
  транзакции (`booking/tx.ts`; для сделок и передач — такие же `deals/tx.ts`, `handoffs/tx.ts`).
- **Идемпотентность.** Запись — `bookings.request_id` и `booking_history.id = opId` (D-132). Сделка и передача —
  **`client_events.id = opId`** (или `requestId` покупки): событие ленты действия вставляется с этим id; строка уже
  есть → повтор, вернуть текущее состояние без эффектов; есть, но про другой объект → `request_reused` (D-248).
  Массовые действия и сверки — по состоянию.
- **Карточку** меняет только машина обзвона через `CardPort` (D-133). Союз `BookingCardEvent` в
  `booking/types.ts` расширяется (T0, §12 задача 0): `| calling.PurchaseEvent | calling.PurchaseCancelledEvent |
  calling.DealLostEvent | calling.AgreedSweepEvent` — порт `cards/bookingPort.ts` уже передаёт событие в
  `calling.applyOutcome` как есть, правки зоны calling не нужно (семантика та же, что у `cards/manual.ts`
  `applyCardEventLocked`, D-251: ядро → `persistTransition`). Ответ `rejected` у сделок **откатывает** действие
  (ошибка 409), у записи — нет (как в B2).
- **Сделку сначала пишет сервис, потом событие карточки** (D-248): эффект ядра (`win`, `lose`,
  `cancel_purchase`) по уже записанной сделке в исполнителе — пустая операция.
- **Задачи** — `tasks/auto.ensureAutoTask`, `closeAutoTaskByKey` (заголовок пустой, текст по `source`/`kind`,
  D-176). Получатель «РОП» — `resolveLead(tx, { spaceId, ownerUserId, at })` из `@/server/domain/cards`.
- **Колокол** — `INSERT INTO notifications (id, user_id, kind, params, dedupe_key, created_at) … ON CONFLICT
  (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING` в транзакции действия; `params` — только id и числа.
  Виды: `handoff_new`, `handoff_assigned`, `handoff_declined`, `handoff_cancelled`, `booking_consult_new`,
  `consultant_assigned`, `reserve_promoted`, `grey_suggest`, `deal_won` (тексты — §8, файл `notify.json` у manager).
- **Аудит** — `writeAudit` в транзакции; новые строки `AUDIT_ACTIONS` и `AuditEntity` модуль добавляет сам вместе с
  кодом (как B2): `deal.purchase`, `deal.purchase_edit`, `deal.purchase_cancel`, `consultant.create`,
  `consultant.update`, `consultant.schedule`; сущности `deal`, `resource`. `meta` — id, коды, числа.
- **Тексты** — только `messages/ru/{booking,deals,handoffs}.json` (§8). Ошибки чужого не раскрывают (§6).

---

## 2. B4 — дежурство на групповом мероприятии и явка

### 2.1. Файлы

| Файл | Что |
|---|---|
| `booking/dutyTypes.ts` | сигнатуры (готово) |
| `booking/duty.ts` | `listDutyEvents`, `markRestNoShow`, `getDutyCandidates` |
| `booking/walkIn.ts` | `registerWalkIn` (§2.6) |
| `booking/opsSettings.ts` | `loadBookingOpsSettings` (`consultTypes.ts`): `booking.grey`, `booking.duty.defaultRole`, `booking.attendance.autoNoShowWorkdays`, `security.phoneProbesPerDay`, ключ источника вида `walk_in` |
| `booking/repo.ts` | + SQL §2.5–2.7 |
| `booking/bookings.ts` | `changeStatus`: после явки закрыть задачи «Отметьте явку» (§3.4); `listGuestRows` — маска гостя без записи (§2.7) |
| `src/app/api/events/duty/route.ts` | `GET` |
| `src/app/api/events/[id]/duty/route.ts` | + `GET` (кандидаты) к существующему `PUT` |
| `src/app/api/events/[id]/no-show-rest/route.ts`, `…/[id]/walk-in/route.ts` | `POST` |
| `src/app/(duty)/duty/page.tsx` | список мероприятий сегодня (заменяет заглушку) |
| `src/app/(duty)/duty/[eventId]/page.tsx` + `_guests/*.tsx` | гости, отметки, «Остальные не пришли», лист «Гость без записи» |
| `src/app/(mgr)/bookings/events/page.tsx` + `_events/*.tsx` | мероприятия на 28 дней: места, дежурные, отмена (существующие API B2) |
| `messages/ru/booking.json` | `duty.*`, `walkIn.*`, `events.*`, новые `errors.*` |
| `tests/…` | §2.9 |

### 2.2. Права

| Действие | Обёртка | В домене | У ЦРП |
|---|---|---|---|
| мероприятия дежурства сегодня | `booking.read` / section | события `scopeSql(v,'event','booking.read')` **и** (`event_duty` = я **или** `scopeOf(v,'booking.attend') !== null`) | РОП — все сегодняшние; оператор и консультант — только где назначены (`duty_today`, D-075) |
| гости | существующий `GET /api/events/[id]/guests` | D-072 + маска §2.7 | то же |
| «Пришёл», «Не пришёл», исправление | существующий `POST /api/bookings/[id]/attendance` | B2 §5.3 | РОП; дежурный своего мероприятия сегодня |
| «Остальные не пришли» | `booking.attend` / object `event` | мероприятие `scopeSql(v,'event','booking.attend')`, записи `scopeSql(v,'booking','booking.attend')` | то же |
| гость без записи | `booking.walk_in` / object `event` | мероприятие `scopeSql(v,'event','booking.walk_in')` | РОП (грант), дежурный (отношение) |
| дежурные: список и назначение | `booking.manage` / object `event` | `scopeSql(v,'event','booking.manage')` | РОП |

Оператор без дежурства явку не ставит (конфликт интересов, PROCESS 8.2): у роли нет `booking.attend`.
Директор — 423 на мутации (обёртка).

### 2.3. API

| Метод и путь | Право / цель | Тело или запрос | Ответ |
|---|---|---|---|
| `GET /api/events/duty` | `booking.read` / section | — | `DutyEventView[]` |
| `GET /api/events/[id]/duty` | `booking.manage` / object `event` | — | `DutyCandidates` (активные сотрудники пространства по имени) |
| `POST /api/events/[id]/no-show-rest` | `booking.attend` / object `event` | `{ opId: uuid, bookingIds: uuid[] (1–1000) }` | `NoShowRestResult` |
| `POST /api/events/[id]/walk-in` | `booking.walk_in` / object `event` | `{ requestId: uuid, phone: string(5–40), name: string(1–120), company: string(0–200) }` | `WalkInResult` (201; 200 при `replayed`) |

### 2.4. Экраны (телефон 360 px, PWA, только онлайн)

- `/duty`: карточки сегодняшних мероприятий: вид (`short`), время, место, «Не отмечено: N», «Пришли: N».
  Одно мероприятие — сразу переход на `/duty/<eventId>`. Пусто — `duty.empty`.
- `/duty/<eventId>`: шапка (время, места, счётчики), поиск по имени в списке (на клиенте), строки гостей:
  имя/компания, контакт, `…4567`, кто записал, статус. Кнопки строки: «Пришёл» (с начала суток мероприятия),
  «Не пришёл» (после начала; до начала кнопка неактивна с подсказкой `duty.notStarted`). У `no_show` —
  «Отметить «Пришёл»», у `attended` в тот же день — «Отметить «Не пришёл»» (исправление, PROCESS 12.40).
  Каждое нажатие — новый `opId`, тело с `version` строки; `409 conflict` → перечитать список.
- Внизу: «Остальные не пришли» (после начала): диалог `duty.restConfirm` с числом, тело — id строк, которые
  сейчас на экране без отметки. «Гость без записи» — лист: номер (`inputmode="tel"`), имя, компания; ответ —
  тост `walkIn.found` / `walkIn.new` / `walkIn.recorded`, список перечитывается. `requestId` создаётся при
  открытии листа и живёт до успеха (D-205).
- `/bookings/events` (РОП, ноутбук и телефон): мероприятия на `horizonDays` (`GET /api/events`), «Мест: 12 из
  30», дежурные (выбор из `GET /api/events/[id]/duty`, сохранение `PUT`), «Отменить мероприятие» с
  подтверждением `events.cancelConfirm` (`POST /api/events/[id]/cancel`). Ссылка на «Дежурство» у сегодняшних.

### 2.5. «Остальные не пришли» (`markRestNoShow`, D-242)

```sql
-- 0. мероприятие видно по booking.attend, иначе 404; cancelled → event_cancelled; now < starts_at → too_early
SELECT e.* FROM events e WHERE e.id = ${eventId} AND ${scopeSql(v,'event','booking.attend')};
-- 1. карточки затронутых записей (без блокировок)
SELECT DISTINCT b.card_id FROM bookings b
 WHERE b.event_id = ${eventId} AND b.id = ANY(${bookingIds}) AND b.status IN ('registered','confirmed')
   AND ${scopeSql(v,'booking','booking.attend')};
-- 2. lockEventCardsInOrder(tx, spaceId, cardIds) — без охвата карточки: дежурному она не видна (D-072)
-- 3. SELECT … FROM events e WHERE e.id = ${eventId} FOR UPDATE OF e
-- 4. те же записи FOR UPDATE OF b ORDER BY b.id (новый оператор после блокировок); строка с карточкой не из шага 2 — skipped
-- 5. на каждую запись (checkTransition(from,'no_show') ok):
UPDATE bookings b SET status = 'no_show', version = b.version + 1, updated_at = ${now}
 WHERE b.id = ${id} AND b.status IN ('registered','confirmed') AND ${scopeSql(v,'booking','booking.attend')} RETURNING b.*;
--    booking_history (id newId, action 'status', from, 'no_show', actor me, meta {opId, bulk: true});
--    лента booking.status {bookingId, from, to: 'no_show', reason: 'bulk'};
--    карточка agreed → CardPort no_show {opId: newId(), bookingId, facts.hasOtherFutureBooking} (B2 §7.1);
--    closeAutoTaskByKey attendance_mark:<id>:marker и :lead (§3.4)
```

Ответ `{ marked, skipped = bookingIds.length − marked }`. Повтор того же тела — `marked: 0` (идемпотентно по
состоянию). Одна транзакция на мероприятие (≤ 30–60 записей).

### 2.6. Гость без записи (`registerWalkIn`, D-241)

```text
0. мероприятие: scopeSql(v,'event','booking.walk_in'), status scheduled, event_date = today, тип групповой, иначе 404 / walk_in_closed
1. номер: phone.parsePhone(input, правила global.phone) → нет или нерабочий → 400 phone_invalid; имя — trim, 1–120
2. повтор: bookings.request_id = requestId → та же event_id → ответ из booking_history.meta.walkIn (replayed); другое — request_reused
3. probes = SELECT count(*) FROM phone_probes WHERE user_id = me AND day = today   -- общий счётчик D-040
   overLimit = probes >= phoneProbesPerDay
4. кандидаты (БЕЗ scopeSql: наружу уходит только found/new, как D-126):
   SELECT c.id AS card_id, c.client_id, c.state, c.owner_user_id, c.last_touch_at
     FROM client_phones cp JOIN clients cl ON cl.id = cp.client_id AND cl.merged_into_id IS NULL
     JOIN cards c ON c.client_id = cl.id AND c.space_id = ${spaceId}
    WHERE cp.digits = ${digits}                         -- client_phones_digits_idx
    ORDER BY c.last_touch_at DESC NULLS LAST, c.id LIMIT 5
   клиент с номером есть, но карточки в пространстве нет — как «новый», только без создания клиента (карточка в пул)
```

**Найден** (берём первую строку; строк > 1 — ещё задача РОП `review`, ключ `walk_in_review:<bookingId>`):

1. Карточка `FOR UPDATE` (по id, без охвата) → мероприятие `FOR UPDATE` → занимающие место записи клиента на
   этом мероприятии `FOR UPDATE`.
2. Запись на это мероприятие уже есть: `registered`/`confirmed`/`no_show` → та же функция, что и ручная явка
   (`changeStatus` с `to: 'attended'`, события карточки B2 §7.1, в том числе исправление № 31); `attended` →
   ничего. Новая запись не создаётся (уникальный индекс `bookings_group_uq`).
3. Иначе `INSERT bookings` (`kind 'group'`, `via 'walk_in'`, `status 'attended'`, `booked_by_user_id` и
   `responsible_user_id` = `cards.owner_user_id` — заслуга владельцу, PROCESS 5.5; `deal_id` = открытая сделка
   клиента в воронке записи или NULL; `request_id`). **Вместимость не проверяется**: гость уже в зале.
4. Последствия по состоянию карточки:
   - `agreed` → `CardPort` `attended { eventDay, facts.hasNextFutureBooking }` (этап «Пришёл», задача шага);
   - `client` → `deps.deals.advanceOnAttended`, если есть `deal_id`; нет будущей записи → задача `next_step`
     (`next_step:<bookingId>`, владельцу, срок `booking.nextStep.taskAt`);
   - `new`, `retry`, `callback` → только задача `next_step` владельцу (без владельца — `resolveLead`);
     состояние не меняется: в таблице переходов такого события нет, итог поставит оператор;
   - закрытые (`not_interested`, `not_target`, `written_off`, `do_not_call`) → задача РОП `review`
     (`walk_in:<bookingId>`), состояние не меняется.

**Не найден** (новый клиент):

1. `pg_advisory_xact_lock(INTAKE_LOCK_KEY)` (D-022) → повторить поиск шага 4 (гонка — уйти в «найден»).
2. `phoneHmac(digits)` в `stop_list` → клиента не создаём, `audit_log` `booking.walk_in_skipped {eventId,
   requestId, answer}`, ответ и его повтор (`answer` из журнала) те же, что у нового гостя (D-301). Остаточный
   признак — у стоп-листа в списке гостей не появляется маскированная строка — принят (D-301 п. 5, D-241). Лимит
   D-040 его не закрывает: сверх лимита нейтрален только ответ, обычный номер всё так же создаёт клиента, карточку
   и строку в списке. Перебор сдерживают видимые следы каждой пробы: клиент, карточка, запись и задача руководителю
   `walk_in_new` у обычного номера, запись журнала `booking.walk_in_skipped` с автором — у номера из стоп-листа.
3. `INSERT clients` (`kind` = `company`, если указана компания, иначе `person`; `name` = компания или имя;
   `name_norm` — `names.normalizeCompanyName`/`normalizePersonName`; `search_norm` —
   `fields.buildSearchNorm({ name, orgId: '', phones: [digits], custom: {}, searchable: [] })`;
   `source_kind 'walk_in'`, `source_key` = ключ источника вида `walk_in` из настроек, нет — 409
   `walk_in_source_missing`), `client_phones` (основной, `kind` из разбора), `contacts` (имя), `client_sources`
   (`walk_in`), `cards` (`new`, владелец NULL, `hold_reason 'rule'`, `hold_code 'walk_in'` — в раздел пула
   «Задержаны правилом», автораздача её не возьмёт), лента `card.created {source: 'walk_in'}`.
4. Мероприятие `FOR UPDATE` → `INSERT bookings` (`via 'walk_in'`, `attended`, заслуга и ответственный NULL,
   сделки нет) → задача РОП `review` (`walk_in_new:<clientId>`, `resolveLead`).

**Всегда:** `INSERT phone_probes (user_id, day, path 'walk_in', matched)`; `booking_history` (`action
'walk_in'`, meta `{ requestId, walkIn: 'found'|'new', ambiguous }`); лента `booking.created {via: 'walk_in'}`.
Ответ — `{ answer, replayed }` одной формы при любом исходе: `overLimit` → `recorded`, иначе `found`/`new`. В ответе
нет имени, id клиента, владельца и id записи (у стоп-листа записи нет — иначе он был бы различим, D-301); запись
попытки — `booking_history.id = requestId`.

### 2.7. Список гостей: маска гостя без записи (D-241)

`listGuestRows`: у строк `via = 'walk_in'` — `clientName = ''`, `contactName = ''`, `phoneTail = ''`,
`bookedByName = ''` (`CASE WHEN b.via = 'walk_in' THEN '' ELSE … END` в SQL, не в JS). Интерфейс пишет
«Гость без записи». Иначе лист «Гость без записи» стал бы справочником «номер → название клиента».

### 2.8. Дежурные мероприятия для экрана (`listDutyEvents`)

```sql
SELECT e.*, x.taken, x.unmarked, x.attended, x.no_show,
       EXISTS (SELECT 1 FROM event_duty d WHERE d.event_id = e.id AND d.user_id = ${me}) AS i_am_duty
  FROM events e
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE b.status IN ('registered','confirmed','attended','no_show'))::int AS taken,
           count(*) FILTER (WHERE b.status IN ('registered','confirmed'))::int AS unmarked,
           count(*) FILTER (WHERE b.status = 'attended')::int AS attended,
           count(*) FILTER (WHERE b.status = 'no_show')::int AS no_show
      FROM bookings b WHERE b.event_id = e.id) x ON TRUE           -- bookings_event_idx
 WHERE e.space_id = ${spaceId} AND e.starts_at >= ${dayStart} AND e.starts_at < ${dayEnd}  -- events_time_idx
   AND e.status = 'scheduled' AND ${scopeSql(v,'event','booking.read')}
   AND (${byRole} OR EXISTS (SELECT 1 FROM event_duty d WHERE d.event_id = e.id AND d.user_id = ${me}))
 ORDER BY e.starts_at, e.id;
-- byRole = scopeOf(v,'booking.attend') !== null; dayStart/dayEnd — местные сутки today в org.timezone
```

### 2.9. Тесты B4

`tests/integration/booking/`:
- `rest-no-show.test.ts` — 5 гостей: 2 отмечены, 3 нет; до начала → `too_early`; после начала с 3 id → 3
  `no_show`, история `bulk`, порт получил 3 `no_show` (карточки `agreed`), задачи «Отметьте явку» закрыты;
  повтор → `marked 0`; id чужого мероприятия в списке → `skipped`; запись, отмеченная «Пришёл» между загрузкой
  экрана и нажатием, не тронута; дежурный вчерашнего мероприятия → 404.
- `walk-in.test.ts` — найден (`agreed`): запись `walk_in`, `attended`, `booked_by` = владелец, порт `attended`,
  этап «Пришёл»; найден с записью `no_show` на это мероприятие → исправление № 31, вторая запись не создана;
  найден `callback` → задача `next_step` владельцу, состояние то же; `do_not_call` → задача РОП; два клиента с
  номером → запись к последнему по активности и задача `walk_in_review`; не найден → клиент `walk_in`, карточка
  `new` с `hold_reason 'rule'`, задача РОП; номер в стоп-листе без клиента → ничего не создано, ответ `new`;
  21-я проверка за день → ответ `recorded`, запись создана; `phone_probes` +1 на каждый вызов кроме повтора;
  повтор `requestId` → `replayed`, одна запись; вместимость 30/30 → гость всё равно записан.
- `guests-mask.test.ts` — JSON списка гостей у строки `walk_in` без имени, контакта, хвоста, автора.
- `duty-events.test.ts` — оператор-дежурный видит только своё мероприятие сегодня; РОП — все сегодняшние;
  оператор без дежурства — пусто; завтрашнего нет.

`tests/isolation/manifest/booking.ts` — 4 новых входа §2.3 и 3 страницы (§9). E2e — §10.

---

## 3. B4b — неотмеченная явка, «Договорились» со следующим шагом, «залежалась»

### 3.1. Файлы

| Файл | Что |
|---|---|
| `booking/sweep.ts` | `workdaysAfter` (чистая), `sweepAttendance` (одна запись, тип `SweepAttendance` из `types.ts`), `runAttendanceSweep`, `countUnmarkedAttendance`, `countAgreedWithoutStep` |
| `booking/jobs.ts` | `attendanceSweepJob: JobDefinition` (и `greyAssignJob` в B5b) |
| `booking/repo.ts` | + SQL §3.2–3.3 |
| `deals/stale.ts`, `deals/rules.ts` | `countStaleDeals`, `staleDaysOf` |
| `tests/…` | §3.7 |

### 3.2. Неотмеченная явка (PROCESS 3.5 № 28, D-243)

Задача `attendance-sweep`: `perSpace: true`, `schedule: () => ({ kind: 'daily', at: '10:00', days: 'workdays' })`,
`writes: 'business'`, `timeoutMs: 5 мин`; обработчик → `runAttendanceSweep(bookingDeps(), ctx.actor, { spaceId,
now })`, `stats` — поля `SweepReport`.

Кандидаты (дата записи раньше сегодня, окно 60 дней, ≤ 500 за прогон, по `starts_at`):

```sql
-- групповые
SELECT b.id, b.card_id, b.starts_at FROM events e JOIN bookings b ON b.event_id = e.id
 WHERE e.space_id = ${spaceId} AND e.starts_at >= ${from60} AND e.starts_at < ${todayStart}   -- events_time_idx
   AND b.status IN ('registered','confirmed')
UNION ALL
-- к консультантам
SELECT b.id, b.card_id, b.starts_at FROM bookings b
 WHERE b.resource_id = ANY(${resourceIdsOfSpace}) AND b.booking_date >= ${from60Day} AND b.booking_date < ${today}
   AND b.status IN ('registered','confirmed')                                                    -- bookings_resource_idx
UNION ALL
-- «серые»
SELECT b.id, b.card_id, b.starts_at FROM bookings b
 WHERE b.space_id = ${spaceId} AND b.kind = 'individual' AND b.resource_id IS NULL
   AND b.status IN ('registered','confirmed') AND b.booking_date >= ${from60Day} AND b.booking_date < ${today}  -- bookings_grey_idx
ORDER BY 3 LIMIT 500;
```

Каждая запись — **своя транзакция** (`sweepAttendance`), исполнитель — система воркера:

1. Карточка `FOR UPDATE` → запись `FOR UPDATE` в `registered|confirmed` (иначе `skipped`).
2. `elapsed = workdaysAfter(calendar, booking_date, today)`; `elapsed = 0` → `skipped`.
3. Отметчик: групповая — первый дежурный (`event_duty` по `created_at, user_id`, активный в пространстве);
   консультация — `resources.user_id` (активный); иначе (нет дежурных, «серая», консультант выключен) —
   `resolveLead`. Нет никого — `skipped`, предупреждение в лог.
4. `reached = autoNoShowWorkdays !== null && elapsed >= autoNoShowWorkdays`.
5. Карточка `agreed` → `CardPort` `attendance_sweep { opId: newId(), bookingId, markerUserId, facts:
   { workdaysElapsed: elapsed, hasOtherFutureBooking } }` (ядро: задачи отметчику и РОП или «Не пришёл» по
   № 16). Иначе — сам домен: не `reached` → две задачи `attendance_mark` (`check`, срок now) с ключами
   `attendance_mark:<id>:marker` и `:lead`; `reached` → закрыть обе.
6. `reached` → `UPDATE bookings SET status = 'no_show', version + 1` (система), история `auto_no_show` (actor
   NULL, meta `{ job: 'attendance-sweep', elapsed }`), лента `booking.status { reason: 'auto' }`.

Повторный прогон в тот же день задачи не задваивает (`tasks_source_uq`), запись уже `no_show` пропускается.

### 3.3. «Договорились» без шага (PROCESS 3.5 № 29, D-049, D-244)

После явки в том же прогоне. «Шаг» = активная будущая запись **или** открытая задача со сроком по клиенту в
пространстве (любой исполнитель: оператор, консультант, РОП).

```sql
SELECT c.id FROM cards c
 WHERE c.space_id = ${spaceId} AND c.state = 'agreed'                                   -- cards_queue_idx (префикс)
   AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.client_id AND b.space_id = c.space_id
                     AND b.status IN ('registered','confirmed') AND b.starts_at > ${now})   -- bookings_client_idx
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.client_id = c.client_id AND t.space_id = c.space_id
                     AND t.status = 'open' AND t.due_at IS NOT NULL)                         -- tasks_client_idx
 ORDER BY c.id LIMIT 500;
```

Каждая карточка — своя транзакция: `FOR UPDATE`, факты заново, `CardPort` `agreed_sweep { opId: newId(), facts:
{ hasFutureBooking, hasOpenOwnerTask } }` (второй факт — «открытая задача со сроком», D-244). Ядро создаёт
`next_step:sweep:<cardId>:<день>` владельцу на `booking.nextStep.taskAt`.

`countAgreedWithoutStep` — тот же запрос `count(*)` по всем пространствам; часть `invariants` (02:40).

### 3.4. Ручная отметка закрывает «Отметьте явку»

В `changeStatus` (B2) при `to ∈ {attended, no_show}` и в §2.5 — `closeAutoTaskByKey` для
`attendance_mark:<bookingId>:marker` и `:lead` в той же транзакции (PROCESS 6.2 «при отметке явки»).

### 3.5. «Сделка залежалась» (D-244)

- `staleDaysOf(deal, stage, now)` (`deals/rules.ts`): `status = 'open'`, у этапа `staleDays`,
  `floor((now − stage_changed_at) / 86 400 000)` ≥ `staleDays` → это число, иначе null. Календарные дни.
- `countStaleDeals({ spaceId, now, pipelines })`: по каждому открытому этапу со `staleDays`:

```sql
SELECT count(*)::int FROM deals d
 WHERE d.space_id = ${spaceId} AND d.pipeline_key = ${p} AND d.status = 'open' AND d.stage_key = ${s}
   AND d.stage_changed_at <= ${now - staleDays * 86_400_000};          -- deals_board_idx
```

- Значок «залежалось N дн.» — в `DealView.staleDays` (страница сделки B6, канбан B8). Тревога РОП — §11.

### 3.6. Регистрация

`src/server/jobs/registry.ts` (зона platform, правка координатора): `attendanceSweepJob` в `jobDefinitions()`;
в `invariantParts` — `{ key: 'agreed_without_step', run: (actor) => countAgreedWithoutStep(actor) }`.

### 3.7. Тесты B4b

- `tests/unit/booking/sweep.test.ts` — `workdaysAfter`: чт → пт = 1, чт → пн = 2, праздник в пятницу не
  считается, перенос рабочего субботнего дня считается; `TZ=UTC` и `TZ=Asia/Almaty`.
- `tests/integration/booking/sweep.test.ts` — БР чт 29.10 без отметки: пт 30.10 10:00 → задачи дежурному и РОП,
  карточка та же; повтор прогона → задач не больше; пн 02.11 → запись `no_show`, карточка `callback` на
  следующий рабочий день 10:00, задача «перезаписать», задачи «Отметьте явку» закрыты; `autoNoShowWorkdays:
  null` → только задачи, без `no_show`; БК без консультанта → отметчик РОП; карточка `client` → `no_show` без
  события карточки; ручная отметка в пт закрывает обе задачи; у клиента есть другая будущая запись → карточка
  остаётся `agreed`.
- `tests/integration/booking/agreed-sweep.test.ts` — `agreed` без записи и задач → задача `next_step` владельцу;
  с открытой задачей консультанта со сроком → ничего; с будущей записью → ничего; повтор в тот же день →
  одна задача; `countAgreedWithoutStep` до и после.
- `tests/unit/deals/stale.test.ts`, `tests/integration/deals/stale.test.ts` — порог ровно N дней, `won`/`lost`
  не считаются, этап без `staleDays` не считается.

---

## 4. B5 — консультации

### 4.1. Части

- **B5a** (без флага, к пилоту): `resources` — список, создать, править (направления, слот, вместимость,
  «участвует в автоназначении», порядок), выключить. Ручное назначение B3b берёт консультантов отсюда.
- **B5b** (`FEATURE_BK_WIZARD`): график и исключения; снимок дня под блокировкой (D-245); запись к
  консультанту и «серая» с проверкой пула; назначение и переназначение с подбором; резерв; `grey-assign`.
- **B5c** (`FEATURE_BK_WIZARD`): «Мои консультации», итог БК, запись клиента к себе; экраны графика.

### 4.2. Файлы

| Файл | Что |
|---|---|
| `booking/consultTypes.ts` | сигнатуры (готово) |
| `booking/consultants.ts` | `listConsultants`, `createConsultant`, `updateConsultant`, `getSchedule`, `setSchedule`, `setException`, `clearException` |
| `booking/consultDay.ts` | `lockConsultDay(tx, spaceId, date)`, `loadDaySnapshot(tx, spaceId, date, calendar)` → `core.DaySnapshot`, `getConsultDay`, `getConsultStrip` |
| `booking/assign.ts` | `assignConsultant`, `listAssignCandidates`, `promoteReserve(tx, …)` |
| `booking/greyJob.ts` | `runGreyAssign`; `greyAssignJob` в `booking/jobs.ts` |
| `booking/consultations.ts` | `listMyConsultations`, `recordConsultResult` |
| `booking/bookings.ts` | ветка `individual` с `resourceId` и проверка пула «серых» (§4.6); `cancel`/`move` консультации → `promoteReserve` |
| `src/app/api/bookings/consultants/route.ts` (`GET`, `POST`), `…/consultants/[id]/route.ts` (`GET`, `PATCH`), `…/consultants/[id]/schedule/route.ts` (`GET`, `PUT`), `…/consultants/[id]/exceptions/[day]/route.ts` (`PUT`, `DELETE`) | B5a/B5b |
| `src/app/api/bookings/consult-day/route.ts` | `GET ?date=` |
| `src/app/api/bookings/wizard/[cardId]/consult/route.ts` | `GET ?type=&direction=` |
| `src/app/api/bookings/[id]/assign/route.ts`, `…/[id]/candidates/route.ts` | `POST`, `GET` (если B3b уже сделал `assign` — тот же контракт, B5b добавляет проверки снимка за флагом) |
| `src/app/api/bookings/mine/route.ts`, `…/[id]/result/route.ts` | `GET`, `POST` |
| `src/app/(mgr)/consultants/page.tsx`, `…/[id]/page.tsx` | список и карточка консультанта (график, исключения — B5c) |
| `src/app/(mgr)/bookings/consult-day/page.tsx` | день консультаций РОП: «серые», конфликты, назначение |
| `src/app/(op)/bookings/_wizard/ConsultStep.tsx` | за флагом — полоса с подбором (`ConsultStripDay`) |
| `src/app/(consultant)/consultations/page.tsx`, `…/[bookingId]/page.tsx` | «Мои консультации», встреча (явка, итог, покупка B6, запись к себе) |

Статический сегмент `consultants`, `consult-day`, `mine` в `/api/bookings/*` имеет приоритет над `[id]` — так в
Next App Router; тест маршрута это закрепляет.

### 4.3. Права

| Действие | Обёртка | В домене | У ЦРП |
|---|---|---|---|
| консультанты, график, исключения, день, назначение, кандидаты | `booking.manage` | `space_id = v.spaceId`; запись — `scopeSql(v,'booking','booking.manage')` | РОП |
| полоса подбора, запись к консультанту | `booking.create` | карточка `scopeSql(v,'card','booking.create')`; **по отношению** (без гранта роли) — только `individual` и `resourceId` = свой ресурс (D-246), иначе 404 | оператор — свои; РОП — все; консультант — клиенты своих БК в окне, к себе |
| «Мои консультации» | `booking.read` / section | `resources.user_id = me` (D-246) | консультант |
| итог БК | `note.write` / object `booking` | запись `scopeSql(v,'booking','note.write')`; этап — `scopeSql(v,'deal','deal.edit')` | консультант (окно), РОП |
| явка БК | существующий `attendance` | `booked_with_me` (окно, своя запись) | консультант, РОП |

Окно консультанта — уже в `scopeSql` (`booked_with_me`, параметры роли `{fromDays: -1, toDays: 30}`); B5 его
проверяет тестами изоляции (§9), кода доступа не пишет.

### 4.4. API

| Метод и путь | Право / цель | Тело или запрос | Ответ |
|---|---|---|---|
| `GET /api/bookings/consultants` | `booking.manage` / section | `?inactive=0\|1` | `ConsultantView[]` |
| `POST /api/bookings/consultants` | `booking.manage` / section | `ConsultantInput` | `ConsultantView` (повтор `requestId` — тот же) |
| `GET`/`PATCH /api/bookings/consultants/[id]` | `booking.manage` / section | `{ seenUpdatedAt, patch }` | `ConsultantView` |
| `GET`/`PUT /api/bookings/consultants/[id]/schedule` | `booking.manage` / section | `{ windows: ScheduleWindowInput[] ≤ 21 }` | `ConsultantSchedule` |
| `PUT`/`DELETE /api/bookings/consultants/[id]/exceptions/[day]` | `booking.manage` / section | `{ kind, windows }` | `ConsultantSchedule` |
| `GET /api/bookings/consult-day` | `booking.manage` / section | `?date=` | `ConsultDayView` |
| `GET /api/bookings/wizard/[cardId]/consult` | `booking.create` / object `card` | `?type=&direction=` | `{ days, current }` |
| `POST /api/bookings` | как B2 | `IndividualBookingRequest` с `resourceId` (за флагом) | `CreateBookingResult` |
| `POST /api/bookings/[id]/assign` | `booking.manage` / object `booking` | `{ opId, version, resourceId }` | `BookingView` |
| `GET /api/bookings/[id]/candidates` | `booking.manage` / object `booking` | — | `SuggestedConsultant[]` |
| `GET /api/bookings/mine` | `booking.read` / section | `?from=&to=` (≤ 62 дня) | `MyConsultation[]` |
| `POST /api/bookings/[id]/result` | `note.write` / object `booking` | `ConsultResultInput` без `bookingId` | `{ bookingId, noteId, taskId, replayed }` |

Проверки тел: направления — ключи `booking.directions`; `slotMin` 5–480; `capacity` 1–5; окна графика
`HH:MM`, `start < end`, без пересечений в одном дне (`schedule_overlap`); исключение `off` — пустые окна,
`custom` — не пустые.

### 4.5. Блокировка дня и снимок (D-245)

```sql
SELECT pg_advisory_xact_lock(${CONSULT_DAY_LOCK_CLASS}::int, hashtext(${spaceId + '|' + date}));
-- консультанты пространства (выключенные нужны для «конфликтов»)
SELECT r.id, r.user_id, u.name, r.directions, r.slot_min, r.capacity, r.auto_assign, r.active, r.sort,
       EXISTS (SELECT 1 FROM resource_schedule s WHERE s.resource_id = r.id) AS uses_schedule
  FROM resources r JOIN users u ON u.id = r.user_id WHERE r.space_id = ${spaceId};
SELECT resource_id, weekday, start_time, end_time FROM resource_schedule
 WHERE resource_id = ANY(${activeIds}) AND weekday = ${isoWeekday(date)};          -- resource_schedule_res_idx
SELECT resource_id, day, kind, windows FROM resource_exceptions
 WHERE resource_id = ANY(${activeIds}) AND day = ${date};                          -- UNIQUE (resource_id, day)
SELECT b.id, b.resource_id, b.start_time, b.duration_min, b.is_reserve, b.created_at, b.direction_key
  FROM bookings b WHERE b.resource_id = ANY(${allIds}) AND b.booking_date = ${date}
   AND b.status IN ('registered','confirmed','attended','no_show')                  -- bookings_resource_idx
UNION ALL
SELECT b.id, NULL, b.start_time, b.duration_min, b.is_reserve, b.created_at, b.direction_key
  FROM bookings b WHERE b.space_id = ${spaceId} AND b.kind = 'individual' AND b.resource_id IS NULL
   AND b.booking_date = ${date} AND b.status IN ('registered','confirmed')          -- bookings_grey_idx
 ORDER BY 3, 6, 1;
```

→ `core.DaySnapshot { date, hours: consult.hours, isWorkday: calendar.isWorkday, consultants (active),
schedules, bookings }`. Снимок читается **после** блокировки. Перенос между датами — блокировки обеих дат по
возрастанию даты. `CONSULT_DAY_LOCK_CLASS = 72_026_107` — в `platform/db/locks.ts` и `ALL_LOCK_VALUES` (§11).

### 4.6. Запись консультации (`placeInTx`, ветка `individual`)

Порядок: карточка `FOR UPDATE` → блокировка дня (дней) → записи клиента `FOR UPDATE` → снимок → решение.

| Случай | Флаг выключен (B3a) | Флаг включён (B5b) |
|---|---|---|
| `resourceId = null` («серая») | `checkConsultSlot` (сетка часов) | `checkConsultSlot` **и** `core.poolRoom(snap, start, dur) > 0`, иначе 409 `pool_full`; `core.greyTiming(...) = 'too_late'` → сразу задача РОП `grey_unassigned:<bookingId>` (срок — начало записи) |
| `resourceId` задан | 500 `Error('B5')` (как сейчас) | консультант активен в пространстве (иначе 404 `consultant_not_found`); `core.rankConsultants(snap, {startTime, durationMin: тип}, direction)` содержит его (иначе 409 `slot_taken` с `alternatives` — первые 3 из ранга); `is_reserve` = `reserve` ранга; `duration_min` = `slotMin` при графике, иначе длительность вида |

Время в будущем и в горизонте — всегда. Повтор вида = перенос (D-042) — как B3a. Новая запись к
консультанту → колокол консультанту `booking_consult_new` (`consult_new:<bookingId>`). Отмена и перенос записи с
`resource_id` → `promoteReserve` старого слота в той же транзакции; отмена консультации закрывает
`grey_unassigned:<id>`. То же — у отмены эффектом карточки `cancel_future` (проигрыш, «Не целевой», «Не звонить»):
дни консультаций клиента блокируются до записей (`lockClientConsultDays`, D-251, D-301); в проигрыше сделки сервисом
(`loseDeal`) — и до сделки. В пути итога звонка исполнитель эффектов (`cards/effects.ts`) при `cancel_future` берёт
дни первыми, до группы задач и сделок: иначе `closeAutoTasks` с `sources: 'all'` держал бы строку
`grey_unassigned:<id>`, пока `grey-assign` держит день и ждёт эту строку (40P01). Тест —
`tests/integration/booking/grey-lock-order.test.ts`.

**Полоса подбора** (`getConsultStrip`): ближайшие `consult.stripDays` рабочих дней в горизонте; на день —
снимок (без блокировки, только чтение); времена = объединение сетки `consult.hours` и стартов слотов
консультантов с графиком; время в полосе, если ранг не пуст или (время в сетке и `poolRoom > 0`).
`suggested` — первый ранга, `others` — до 5 следующих, `greyAllowed` — `poolRoom > 0`. Для консультанта по
отношению — только своё имя в ранге, остальные отброшены. `ConsultStep` за флагом: направление → день → время →
«Записать к <имя>» (2-е нажатие подтверждает) или «Назначим утром» (если `greyAllowed`).

### 4.7. Назначение, переназначение, резерв

`assignConsultant`: запись (охват `booking.manage`) → карточка `FOR UPDATE` → день → запись `FOR UPDATE` →
повтор `opId` (`booking_history.id`) → `version` → `kind = 'individual'`, статус `registered|confirmed`, начало
в будущем → флаг включён: `core.rankAssignCandidates(snap, booking, direction)` содержит `resourceId` (иначе
409 `slot_taken`); выключен: консультант активен в пространстве.

```sql
UPDATE bookings b SET resource_id = ${resourceId}, is_reserve = FALSE, duration_min = ${dur},
       grey_processed_at = COALESCE(b.grey_processed_at, ${now}), version = b.version + 1, updated_at = ${now}
 WHERE b.id = ${id} AND b.version = ${version} AND ${scopeSql(v,'booking','booking.manage')} RETURNING b.*;
```

История `assigned` (meta `{opId, resourceId, from}`), лента `booking.assigned`, закрыть `grey_unassigned:<id>`,
колокол консультанту (`booking_consult_new`) и автору записи (`consultant_assigned`, `assigned:<id>:<resourceId>`).
Был другой консультант → `promoteReserve` его слота.

`promoteReserve(tx, { resourceId, date, startTime })`: занимающие место записи консультанта, пересекающиеся со
слотом, `FOR UPDATE` → `core.reserveToPromote(list, capacity)` → `UPDATE … SET is_reserve = FALSE`, история
`promoted`, колокол консультанту и ответственному (`reserve_promoted`).

### 4.8. Автоназначение `grey-assign` (D-247)

`greyAssignJob`: `perSpace: true`; `schedule` — `{ kind: 'grid', from: grey.schedule.first, to: grey.schedule.last,
everyMin: grey.schedule.stepMin, days: 'workdays', graceMin: stepMin }`; флаг `BK_WIZARD` выключен → `skipped`
(`note: 'flag_off'`). Прогон — одна транзакция на сегодняшнюю дату: блокировка дня → снимок →
`core.planGreyProposals(snap, core.pendingGreys(core.greyBookings(snap), null, new Set(), mode))`:

- `assign`: каждое предложение — `UPDATE … WHERE id AND resource_id IS NULL AND status IN ('registered','confirmed')`
  (система, история `assigned` с actor NULL, `grey_processed_at`), закрыть `grey_unassigned`, колокол как в §4.7;
- `suggest`: колокол РОП (`grey_suggest`, ключ `grey_suggest:<bookingId>` — один раз на заявку), назначения нет;
- `unassignable` → `ensureAutoTask` РОП `grey_unassigned:<bookingId>` (`check`, срок — начало записи).

Будущие даты прогон не трогает: их «серые» назначатся в 09:00 своего дня (PROCESS 5.2).

### 4.9. «Мои консультации» и итог БК (D-246)

```sql
SELECT b.id, b.booking_date, b.start_time, b.duration_min, b.status, b.direction_key, b.is_reserve, b.version,
       (${scopeSql(v,'client','client.read',{alias:'cl'})}) AS in_window,
       b.client_id, b.card_id, b.deal_id, cl.name AS client_name
  FROM resources r
  JOIN bookings b ON b.resource_id = r.id AND b.booking_date BETWEEN ${from} AND ${to}   -- bookings_resource_idx
  JOIN clients cl ON cl.id = b.client_id
 WHERE r.user_id = ${me} AND r.space_id = ${spaceId}
   AND b.status IN ('registered','confirmed','attended','no_show')
 ORDER BY b.booking_date, b.start_time, b.id;
-- вне окна (in_window = false) сервис обнуляет clientId, cardId, dealId, clientName до ответа
```

Экран `/consultations`: «Сегодня», «Завтра», «Позже» (без имени: «Клиент откроется за день до встречи»),
«Не отмечено» (прошедшие `registered|confirmed` за 30 дней). Страница встречи `/consultations/<bookingId>`
(перм `booking.read`, object `booking`): клиент и контакт (поля — только чтение), сделка, кнопки «Пришёл» /
«Не пришёл», «Итог встречи», «Покупка» (ссылка на B6 `/deals/purchase/<cardId>`), «Записать на следующую БК»
(мастер с консультантом = я).

`recordConsultResult`: запись (`note.write`) → карточка `FOR UPDATE` → запись `FOR UPDATE`, статус `attended`
(иначе 409 `not_attended`) → повтор (`client_events.id = opId`) → заметка как в C8 (`tasks-team-design.md` §3:
`notes.id = opId`, `deal_id = b.deal_id`, `body ≤ 2000`, лента `note.created`; есть экспорт `timeline/notes.ts` —
звать его, нет — тот же `INSERT` в `booking/repo.ts`) → `nextStep` → ручная задача себе как в B7 (`source
'manual'`, `tasks.id` — новый (повтор отсёк шаг `opId`), `source_key NULL`, `deal_id`; её можно закрыть руками,
в отличие от `next_step`) → `toStageKey` → перенос той же транзакцией с проверкой требований этапа §5.7
(`assertStageRequirements`, шаг этого итога засчитан; отказ — 409 с кодом сделок, D-301) → лента
`booking.result` с `id = opId` (`{ bookingId, noteId, taskId, toStageKey }`). Пустая заметка без шага и этапа — 400.

### 4.10. Тесты B5

`tests/unit/booking/consult-strip.test.ts` — объединение сетки и слотов графика, отбор по рангу и пулу.
`tests/integration/booking/`:
- `consultants.test.ts` — создать (повтор `requestId` — один), второй ресурс того же сотрудника →
  `consultant_exists`, правка с устаревшим `seenUpdatedAt` → 409, выключение: будущие записи остаются и видны в
  «конфликтах»; график с пересечением → `schedule_overlap`; исключение `off` гасит день.
- `consult-place.test.ts` — к консультанту в его слот → `resource_id`, длительность = слот; занятый слот при
  вместимости 2 → резерв; при 1 → `slot_taken` с альтернативами; прямая запись, отнимающая место у «серой», →
  `slot_taken` (`starvedGreyBooking`); «серая» без места в пуле → `pool_full`; «серая» после последнего
  прогона на сегодня → задача РОП; флаг выключен → как B3a.
- `consult-race.test.ts` — два оператора на один свободный слот одного консультанта (`Promise.all`, 20 раз)
  → одна основная, вторая `slot_taken` (вместимость 1) или резерв (вместимость 2); «серая» и прямая на одно
  время при одном консультанте в пуле → проходит ровно одна.
- `assign.test.ts` — назначение «серой», задача `grey_unassigned` закрыта, колокол консультанту; кандидат вне
  графика → `slot_taken`; переназначение → резерв старого слота повышен; повтор `opId` → без второго колокола.
- `grey-job.test.ts` — `assign`: три «серые», два консультанта с подходящими направлениями → две назначены по
  рангу, третья → задача РОП; следующий прогон после исключения `custom` → назначена; `suggest` → только
  колокол, один раз на заявку; флаг выключен → `skipped`.
- `consultations.test.ts` — консультант видит свои записи на 14 дней, имена — только сегодня и завтра (окно
  −1/+30), чужие не видит; итог БК: заметка, задача, этап «Переговоры»; до явки → `not_attended`; повтор
  `opId` → одна заметка.
- `consult-relation.test.ts` — консультант записывает клиента своей БК к себе (`resourceId` свой) → ок; к
  другому консультанту → 404; групповую → 404; клиента вне окна → 404.

---

## 5. B6 — сделки, покупки, передача в отдел

### 5.1. Файлы

| Файл | Что |
|---|---|
| `deals/types.ts` | сигнатуры (готово) |
| `deals/settings.ts` | `loadDealsSettings`: воронки целиком (`DealPipelineInfo`, расширяет `parsePipelines`), `serviceTypes`, `reasons.deal_lost`, `deals.purchaseFutureLimitHours`, `handoff.acceptSlaWorkdays`, календарь, `workHours.end` |
| `deals/rules.ts` | чистые: `wonStageOf`, `lostStageOf`, `isForward`, `stageRequirements`, `purchaseMoment(wonDay, tz, now, limitH)`, `staleDaysOf`, `checkAmount` |
| `deals/tx.ts`, `deals/deps.ts` | `inDealsTx` (как `booking/tx.ts`), `dealsDeps()` (`cards: cardBookingPort`) |
| `deals/purchase.ts` | `registerPurchase`, `editPurchase`, `cancelPurchase`, `getPurchaseForm`, общий `writeWin` |
| `deals/stage.ts` | `moveDealStage`, `loseDeal` |
| `deals/read.ts` | `getDealPage`, `toDealView` |
| `deals/stale.ts` | `countStaleDeals` (B4b) |
| `deals/effects.ts` | исполнитель: `win`, `cancel_purchase`, `lose` (§5.8) |
| `deals/repo.ts` | + SQL |
| `handoffs/create.ts`, `handoffs/repo.ts` | `createHandoffForDeal`, `cancelHandoffOfDeal` (§5.6) |
| `src/app/api/deals/purchase/route.ts` | `POST` |
| `src/app/api/deals/[id]/route.ts` | `GET` |
| `src/app/api/deals/[id]/{purchase,cancel-purchase,stage,lose}/route.ts` | `PATCH`, `POST`, `POST`, `POST` |
| `src/app/(mgr)/deals/[dealId]/page.tsx` | страница сделки (список `/deals` — канбан B8) |
| `src/app/(mgr)/deals/purchase/[cardId]/page.tsx` + `src/app/(mgr)/deals/_components/PurchaseForm.tsx` | форма покупки (её же встраивает страница встречи консультанта) |
| `messages/ru/deals.json` | §8 |

### 5.2. Права

| Действие | Обёртка | В домене | У ЦРП |
|---|---|---|---|
| страница сделки | `deal.read` / object `deal` | `scopeSql(v,'deal','deal.read')`; история — `client_events` с `deal_id` и `scopeSql(v,'client_event','card.read')` | оператор — свои; РОП, директор — все; консультант — окно |
| форма и регистрация покупки | `deal.purchase` / object `card` | карточка и сделка — `scopeSql(…,'deal.purchase')` | РОП; консультант — клиенты своих БК в окне; оператор — нет (PROCESS 14 № 15) |
| этап вперёд, проигрыш | `deal.edit` / object `deal` | `scopeSql(v,'deal','deal.edit')` | РОП; консультант в окне |
| этап назад | `deal.edit` + в домене `scopeOf(v,'deal.move_back') !== null`, иначе 403 | — | РОП |
| правка и отмена покупки | `deal.move_back` / object `deal` | `scopeSql(v,'deal','deal.move_back')` | РОП |

### 5.3. API

| Метод и путь | Право / цель | Тело | Ответ |
|---|---|---|---|
| `GET /api/deals/[id]` | `deal.read` / object `deal` | — | `DealPageView` |
| `POST /api/deals/purchase` | `deal.purchase` / section | `PurchaseInput` | `PurchaseResult` (201; 200 при `replayed`) |
| `PATCH /api/deals/[id]/purchase` | `deal.move_back` / object `deal` | `{ opId, version, amountKzt?, wonDay? }` | `DealView` |
| `POST /api/deals/[id]/cancel-purchase` | `deal.move_back` / object `deal` | `{ opId, version, mode, comment (1–500) }` | `DealView` |
| `POST /api/deals/[id]/stage` | `deal.edit` / object `deal` | `{ opId, version, stageKey, nextStep }` | `DealView` |
| `POST /api/deals/[id]/lose` | `deal.edit` / object `deal` | `{ opId, version, reasonCode, reasonText }` | `DealView` |

Zod: `amountKzt` — `z.number().int().min(0).max(1e12)` (строка или дробь → 400 `amount_invalid`), `wonDay` —
`YYYY-MM-DD`, `opId`/`requestId` — `uuid()`. Маршрут `POST /api/deals/purchase` получает `cardId` из тела —
поэтому в манифесте это `section`, а охват проверяет сервис (404 на чужую карточку тем же телом).

### 5.4. Покупка (`registerPurchase`, PROCESS 3.5 № 19, 4.3, D-248)

```text
1. флаг PURCHASES, requireSpace, settings
2. карточка:
   SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
     FROM cards c WHERE c.id = ${cardId} AND ${scopeSql(v,'card','deal.purchase')} FOR UPDATE OF c   → нет: 404
3. повтор: SELECT client_id, kind, data FROM client_events WHERE id = ${requestId}
   есть, kind = 'deal.won' и тот же клиент → { deal: data.dealId, handoffId, replayed: true }; иначе 409 request_reused
4. проверки: тип услуги в settings.serviceTypes (400 service_type_unknown); amount (400 amount_invalid);
   wonAt = purchaseMoment(wonDay, tz, now, limitH): день → 12:00 местного; > now + limitH или < now − 400 дн. → 400 won_at_invalid;
   state ∉ {agreed, callback, client} → 409 outcome_required
5. сделка:
   dealId задан → SELECT … FROM deals d WHERE d.id = ${dealId} AND d.card_id = ${card.id}
                   AND ${scopeSql(v,'deal','deal.purchase')} FOR UPDATE OF d → нет: 404; status ≠ open → 409 deal_closed
   воронка = воронка сделки или воронка записи (createDealOn: agreed), иначе первая; этап «Покупка» = wonStageOf → нет: 409 invalid_settings
6. writeWin (§5.8): сделка → won, лента deal.won с id = requestId, передача (§5.6)
7. CardPort: { type: 'purchase', opId: requestId, dealId, serviceTypeKey, amountKzt } → rejected → 409 (код ядра),
   транзакция откатывается целиком; applied → карточка client, задачи по leaveTasks; эффект win — пустой (сделка уже won)
8. колокол владельцу карточки deal_won (если владелец ≠ я), ключ deal_won:<dealId>; аудит deal.purchase {dealId, serviceTypeKey, amountKzt, newDeal}
```

Новая сделка (`dealId = null`): `INSERT deals (…, stage_key = won, status 'won', owner_user_id =
card.owner_user_id, service_type_key, amount_kzt, won_at, stage_changed_at = now, request_id = requestId,
created_by) ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING RETURNING id` — пусто → 409
`request_reused`. Две услуги сразу — две покупки, две сделки (PROCESS 4.3).

### 5.5. Правка и отмена покупки (D-249)

- **Правка** (`editPurchase`): карточка `FOR UPDATE` → сделка `FOR UPDATE` (`deal.move_back`) → повтор (`client_events.id`)
  → `version` → `status = 'won'` (иначе 409 `deal_not_won`) → `UPDATE deals SET amount_kzt, won_at, version + 1` →
  лента `deal.purchase_edited` `{dealId, fromAmount, toAmount, fromWonAt, toWonAt}` → аудит `deal.purchase_edit`.
  Тип услуги не правится (`service_type_locked`): смена типа меняет передачу — только отмена «ошибка» и новая покупка.
- **Отмена** (`cancelPurchase`, № 20, 12.29): те же блокировки → `refund`: `status 'lost'`, этап `lostStageOf`,
  `lost_reason_code 'refund'`, `lost_at`; `error`: этап до покупки — `data.fromStage` последнего `deal.won` этой
  сделки; был `null` (сделка создана сразу выигранной) → `lost` с причиной `input_error` (в отчёт причин не
  входит, как 12.7); иначе `status 'open'`, `stage_key = fromStage`, `won_at NULL`, `service_type_key ''`,
  `amount_kzt 0`, `stage_changed_at = now`. Затем `cancelHandoffOfDeal`; комментарий — заметка с `deal_id` (как C8);
  лента `deal.purchase_cancelled {dealId, mode}`; аудит.
  Карточка: у клиента есть другая выигранная сделка → события нет (остаётся `client`); иначе карточка
  `client` → `CardPort` `purchase_cancelled { dealId, comment, facts: { hasOtherOpenDeal: есть открытая
  сделка клиента после шага выше } }` → `agreed` или `callback` с задачей.

### 5.6. Передача в отдел (`createHandoffForDeal`, D-250)

```sql
SELECT t.id, t.space_id, t.lead_user_id,
       EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
                WHERE m.user_id = t.lead_user_id AND m.space_id = t.space_id AND m.status = 'active') AS lead_active
  FROM teams t WHERE t.space_id = ${spaceId} AND t.key = ${teamKey} AND t.archived_at IS NULL;
-- нет отдела → null (покупка проходит, предупреждение в лог)
-- due = calendar.nthWorkdayAt(at, acceptSlaWorkdays, workHoursEnd)   (чт 14:00 → пт 18:00)
INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, due_at, created_at)
VALUES (${id}, ${spaceId}, ${t.space_id}, ${t.id}, ${dealId}, ${clientId}, 'pending', ${due}, ${at})
ON CONFLICT (deal_id) DO NOTHING RETURNING id;
-- конфликт со строкой 'cancelled' (покупку отменили «ошибкой» и зарегистрировали снова) →
UPDATE handoffs SET status = 'pending', assignee_user_id = NULL, accepted_at = NULL, accepted_by = NULL,
       declined_reason = '', due_at = ${due}, alarm_sent_at = NULL WHERE deal_id = ${dealId} AND status = 'cancelled';
```

- Руководитель активен → задача ему: `kind 'handoff'`, `source 'handoff'`, `team_id`, `deal_id`, срок `due`,
  ключ `handoff:<id>`; колокол `handoff_new` (`handoff_new:<id>`).
- Руководителя нет → задача РОП (`resolveLead(space, owner)`), `kind 'check'`, ключ `handoff_nolead:<id>`
  («Назначьте руководителя отдела»); передача ждёт (вопрос владельцу §13, PROCESS 12.30).
- Лента `handoff.created { handoffId, teamKey, serviceTypeKey }`, `ref_type 'handoff'`. Оператору — никогда.
- Тревога «передача не принята» уже считает `notify/alarms.ts` (`status = 'pending' AND due_at <= now`) — B6
  только ставит `due_at` правильно.

`cancelHandoffOfDeal`: `UPDATE handoffs SET status = 'cancelled' WHERE deal_id AND status IN ('pending','accepted','declined')`
→ закрыть `handoff:`, `handoff_nolead:`, `handoff_work:`, `handoff_declined:` → колокол руководителю и исполнителю
`handoff_cancelled`, если передача была `pending`/`accepted` (отказавшему отделу — нет). Отклонённая строка иначе
держала бы `ON CONFLICT (deal_id)`, и исправленная покупка не дошла бы до отдела (D-301).

### 5.7. Этап и проигрыш

- `moveDealStage`: сделка (`deal.edit`) → карточка `FOR UPDATE` → сделка `FOR UPDATE` → повтор → `version` →
  `status = 'open'` (иначе `deal_closed`) → целевой этап открытый (`won` → 400 `use_purchase`, `lost` → 400
  `use_lose`, нет → 400 `stage_unknown`) → назад (`order` меньше) без `deal.move_back` → 403 → требования
  (`assertStageRequirements` в `deals/requirements.ts` — одна проверка и для итога встречи §4.9, D-301): этап требует
  поле, скрытое роли зрителя, — 409 `stage_restricted` без списка до чтения значений (D-323);
  `nextTask` — `nextStep` в теле или открытая задача со сроком по сделке, иначе 409
  `next_step_required`; `fields` — непустые ключи в `deals.custom`, иначе 409 `stage_fields_required`
  (`detail` + список ключей); `booking`/`attendance` — есть запись / явка по сделке (`bookings_deal_idx`) →
  `UPDATE deals SET stage_key, stage_changed_at = now, version + 1 WHERE id AND version AND status = 'open' AND
  scope` → задача шага — ручная, как в B7 (`source 'manual'`, исполнитель — я, `deal_id`, `source_key NULL`) → лента
  `deal.stage {from, to, cause: 'manual'}` с `id = opId`. Карточку не трогает.
- `loseDeal` (№ 21): причина из `reasons.deal_lost` (иначе 400 `reason_unknown`), `needsText` → текст 1–500
  (`reason_text_required`) → блокировки, повтор, версия, `open` → `UPDATE deals SET status 'lost', stage
  lostStageOf, lost_at, lost_reason_code, lost_reason_text` → лента `deal.lost` (`id = opId`, без текста) →
  карточка `agreed` → `CardPort` `deal_lost { dealId, reasonCode, softness, facts: { hasOtherOpenDeal } }`
  (ядро: при последней открытой — `not_interested` или `not_target`); иначе карточка не меняется.

### 5.8. Исполнитель эффектов (`deals/effects.ts`)

| Операция | Действие |
|---|---|
| `win` | сделка уже `won` с этим `request_id` в ленте → ничего; `open` → `writeWin` с `won_at = at`; `dealId = null` и сделки с `request_id` нет → `writeWin` новой; `lost` → `Error` (ошибка сборки) |
| `cancel_purchase` | сделка `won` → как `refund` в §5.5 (+ `cancelHandoffOfDeal`); иначе ничего |
| `lose` | сделка `open` → `loseOne` (есть); иначе ничего |
| `reassign_open` | уже делается по `tasks-team-design.md` §1.4 (24.10) — B6 его не трогает |

`writeWin(tx, actor, { card, deal | null, pipeline, wonStageKey, serviceTypeKey, amountKzt, wonAt, requestId, at, settings })`
— единственный код записи покупки: `UPDATE`/`INSERT` сделки, `client_events` `deal.won` (`id = requestId`,
`data {dealId, fromStage, toStage, serviceTypeKey, amountKzt, wonAt}`), `createHandoffForDeal`, если у типа
услуги `routeToTeam`.

### 5.9. Экраны

- `/deals/purchase/<cardId>` (`deal.purchase`, object `card`, флаг): клиент, «Сделка» (открытые сделки или
  «Новая сделка»; по умолчанию `defaultDealId`), «Услуга», «Сумма, ₸» (`inputmode="numeric"`, только цифры,
  пробелы при показе через `Intl.NumberFormat('ru-RU')`), «Дата» (сегодня), «Зарегистрировать». `requestId`
  живёт до успеха (D-205); после успеха — переход на `/deals/<dealId>`. `allowed = false` → `deals.outcomeFirst`
  и ссылка на карточку клиента.
- `/deals/<dealId>` (`deal.read`, object `deal`): клиент, этап, значки («нужна перезапись», «залежалось N дн.»),
  сумма и тип для выигранной, история (§4.5 PROCESS), записи, передача; кнопки по `can`: «Покупка»,
  «Переместить в…» (лист этапов, на телефоне без перетаскивания), «Проигран», у РОП «Изменить сумму»,
  «Отменить покупку» (диалог: «Возврат денег» / «Ошибка ввода», комментарий обязателен).
- Ссылки сюда: страница встречи консультанта (B5c), канбан (B8), карточка клиента (C8 — §11).

### 5.10. Тесты B6

`tests/unit/deals/rules.test.ts` — `purchaseMoment` (день → 12:00 Asia/Almaty, +36 ч, −400 дн.), `isForward`,
`stageRequirements`, `checkAmount` (−1, 1.5, 1e12+1, `'450000'`).
`tests/integration/deals/`:
- `purchase.test.ts` — консультант в окне: открытая сделка «Переговоры» → `won`, сумма 450 000, `won_at` 12:00
  дня, карточка `agreed → client`, лента `deal.won` с `id = requestId`, передача SMM → `pending`, срок пт 18:00,
  задача главе маркетинга, колокол; **повтор того же `requestId` (последовательно и `Promise.all`) → одна
  сделка, одна передача, одна задача, один колокол, ответ `replayed`**; тот же ключ на другую карточку →
  `request_reused`; `dealId = null` → вторая сделка сразу `won`; «Мастер-группа» → без передачи; карточка
  `retry` → `outcome_required`, ничего не записано; закрытая сделка → `deal_closed`; сумма −1, 1.5, строка →
  400; оператор → 404; консультант вне окна → 404; флаг выключен → 404.
- `purchase-cancel.test.ts` — `refund`: `lost/refund`, передача `cancelled`, задачи закрыты, колокол отделу,
  карточка `client → callback` (нет открытых) или `agreed` (есть открытая); `error` после «Переговоров» →
  сделка снова «Переговоры», сумма 0; `error` у сделки, созданной сразу выигранной, → `lost/input_error`; у
  клиента вторая выигранная сделка → карточка остаётся `client`; правка суммы → аудит без ПДн; смена типа
  услуги → `service_type_locked`; повторная покупка после `error` → передача снова `pending`.
- `stage.test.ts` — вперёд на «Переговоры» без шага → `next_step_required`, с шагом → задача; назад
  консультантом → 403, РОП → ок; `won`/`lost` целью → 400; устаревшая версия → 409; проигрыш последней
  открытой при `agreed` → `not_interested` (мягкая) / `not_target` (жёсткая), будущие записи отменены.
- `effects.test.ts` — `win`, `lose`, `cancel_purchase` по уже записанной сделке — без изменений; `win` по
  открытой без сервиса — полная покупка с `won_at = at`.
- `handoff-create.test.ts` — без руководителя → задача РОП `handoff_nolead`; отдел архивный → передачи нет,
  покупка прошла; срок через праздник (`nthWorkdayAt`).

---

## 6. Ошибки и HTTP (B4–B6b)

| Код | HTTP | Ответ |
|---|---|---|
| чужое и несуществующее (`*_not_found`, `consultant_not_found`, чужая карточка покупки) | 404 | `NotFoundError` — тело как у несуществующего |
| `slot_taken` | 409 | `{ error: 'conflict', detail: 'slot_taken', alternatives: SuggestedConsultant[] }` |
| `pool_full`, `consultant_inactive`, `consultant_exists`, `not_attended`, `walk_in_closed`, `walk_in_source_missing`, `outcome_required`, `request_reused`, `deal_closed`, `deal_not_won`, `next_step_required`, `service_type_locked`, `invalid_settings`, `already_handled`, коды автомата записи (`too_early`, `event_cancelled` …) | 409 | `{ error: 'conflict', detail: <код> }` |
| `stage_fields_required` | 409 | `{ error: 'conflict', detail, fields: string[] }` — только поля, видимые роли (D-323) |
| `stage_restricted` | 409 | `{ error: 'conflict', detail }` — этап требует поле, скрытое роли; исход не зависит от значения (D-323) |
| `phone_invalid`, `schedule_overlap`, `service_type_unknown`, `amount_invalid`, `won_at_invalid`, `stage_unknown`, `use_purchase`, `use_lose`, `reason_unknown`, `reason_text_required`, `reason_required`, `not_team_member`, плохое тело | 400 | `BadRequestError(<код>)` / ZodError |
| этап назад без `deal.move_back` | 403 | `ForbiddenError` |
| устаревшая `version` / `seenUpdatedAt` | 409 | `ConflictError` |

Классы: `BookingDomainError` (есть) принимает и `ConsultDomainErrorCode`; новые `DealDomainError`,
`HandoffDomainError` по образцу `booking/errors.ts`; разбор в `src/app/api/{deals,handoffs}/_lib.ts`.

---

## 7. B6b — входящие передачи (глава отдела и исполнитель)

### 7.1. Файлы

| Файл | Что |
|---|---|
| `handoffs/types.ts` | сигнатуры (готово) |
| `handoffs/inbox.ts` | `listHandoffs`, `getHandoff`, `listHandoffMembers` |
| `handoffs/actions.ts` | `acceptHandoff`, `declineHandoff`, `assignHandoff` |
| `handoffs/repo.ts`, `handoffs/tx.ts`, `handoffs/index.ts` | SQL, транзакция с повтором, реэкспорт |
| `src/app/api/handoffs/route.ts` (`GET`), `…/[id]/route.ts` (`GET`), `…/[id]/{accept,decline,assign}/route.ts` (`POST`), `…/[id]/members/route.ts` (`GET`), `_lib.ts` | API |
| `src/app/(mgr)/handoffs/page.tsx` (заменяет заглушку), `…/[id]/page.tsx` | экраны |
| `messages/ru/handoffs.json` | §8 |

### 7.2. Права (отношения D-016; ничего нового в `scope.ts`)

| Действие | Обёртка | В домене | У ЦРП |
|---|---|---|---|
| список, карточка передачи | `handoff.read` | `scopeSql(v,'handoff','handoff.read')` | глава маркетинга — `pending`/`accepted` своего отдела; маркетолог — назначенные ему; РОП, директор — все (охват роли) |
| принять, отклонить | `handoff.accept` / object `handoff` | `UPDATE … AND ${scopeSql(v,'handoff','handoff.accept')}` | глава отдела (отношение) |
| назначить, список сотрудников | `handoff.assign` / object `handoff` | то же с `handoff.assign` | глава отдела |

РОП и директор видят, но не принимают (нет `handoff.accept`) → 404 на действия. Клиент отдела виден
главе и исполнителю только пока передача `pending|accepted` (`LIVE_HANDOFF` в `scope.ts`): после отказа и
отмены — 404.

### 7.3. SQL

```sql
-- список (≤ 200): ждущие сверху, по сроку
SELECT h.id, h.status, h.team_id, t.key AS team_key, h.deal_id, h.client_id, cl.name AS client_name,
       d.service_type_key, d.won_at, ou.name AS seller_name, h.assignee_user_id, au.name AS assignee_name,
       h.due_at, h.accepted_at, h.created_at, h.declined_reason
  FROM handoffs h JOIN teams t ON t.id = h.team_id JOIN deals d ON d.id = h.deal_id
  JOIN clients cl ON cl.id = h.client_id
  LEFT JOIN users ou ON ou.id = d.owner_user_id LEFT JOIN users au ON au.id = h.assignee_user_id
 WHERE ${scopeSql(v,'handoff','handoff.read')} AND h.status = ANY(${statuses})     -- handoffs_inbox_idx / handoffs_assignee_idx
 ORDER BY (h.status = 'pending') DESC, h.due_at, h.id LIMIT ${limit};
-- declined_reason — только у status = 'declined' (отделу такие не видны: LIVE_HANDOFF), то есть РОП и директору;
-- сумма сделки в ответ не входит (вопрос §13). Форма покупки — страница /deals/purchase/[cardId] (getPurchaseForm), без API.

-- принять
UPDATE handoffs h SET status = 'accepted', accepted_at = ${now}, accepted_by = ${me}
 WHERE h.id = ${id} AND h.status = 'pending' AND ${scopeSql(v,'handoff','handoff.accept')} RETURNING h.id;
-- 0 строк: видна по handoff.read → 409 already_handled, иначе 404

-- отклонить (только из pending; причина 1–500)
UPDATE handoffs h SET status = 'declined', declined_reason = ${reason}
 WHERE h.id = ${id} AND h.status = 'pending' AND ${scopeSql(v,'handoff','handoff.accept')} RETURNING h.*;

-- назначить (pending принимается тем же действием, D-250)
UPDATE handoffs h SET assignee_user_id = ${userId}, status = 'accepted',
       accepted_at = COALESCE(h.accepted_at, ${now}), accepted_by = COALESCE(h.accepted_by, ${me})
 WHERE h.id = ${id} AND h.status IN ('pending','accepted') AND ${scopeSql(v,'handoff','handoff.assign')} RETURNING h.*;
-- исполнитель: SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
--   WHERE m.user_id = ${userId} AND m.team_id = h.team_id AND m.status = 'active'  → иначе 400 not_team_member
```

Каждое действие: блокировка строки передачи (`SELECT … FOR UPDATE` с тем же охватом) → повтор
(`client_events.id = opId`, вид `handoff.*`; ответ повтора — только если передача и сейчас в охвате действия при
статусе, из которого оно выполнялось, иначе тот же 404, D-301) → `UPDATE` → эффекты → лента `handoff.accepted|declined|assigned`
(`id = opId`, `data {handoffId, assigneeUserId?}`, без текста причины).

| Действие | Эффекты |
|---|---|
| принять | закрыть `handoff:<id>` и `handoff_nolead:<id>` |
| отклонить | закрыть те же; задача РОП `handoff_declined:<id>` (`check`, `resolveLead(space, d.owner_user_id)`, срок now); колокол РОП `handoff_declined` |
| назначить | закрыть `handoff:<id>`; задача исполнителю `handoff_work:<id>` (`kind 'handoff'`, срок `nextWorkdayAt(now, callWindowStart)`; уже открыта у другого — `UPDATE tasks SET assignee_user_id`); колокол `handoff_assigned` |

### 7.4. Экраны

- `/handoffs` (телефон): вкладки «Ждут» / «В работе» / «Закрытые» (РОП — все отделы); строка: клиент, услуга,
  кто продал, срок («просрочено» красным с текстом и значком), исполнитель. Пусто — `handoffs.empty`.
- `/handoffs/<id>`: клиент (ссылка на `/clients/<clientId>` — чтение по отношению), услуга, дата покупки,
  кнопки «Принять», «Назначить исполнителя» (лист сотрудников отдела), «Отклонить» (причина обязательна).
  Маркетолог видит карточку без кнопок и ссылку на свои задачи (B7).

### 7.5. Тесты B6b

`tests/integration/handoffs/`:
- `inbox.test.ts` — глава маркетинга видит `pending` и `accepted` своего отдела, не видит чужого отдела и
  отклонённые; маркетолог — только назначенные; РОП — все.
- `actions.test.ts` — принять → задача закрыта; повтор `opId` → то же без новых эффектов; второй глава
  (другой отдел) → 404; принять уже принятую → `already_handled`; отклонить без причины → 400; отклонить →
  клиент главе 404 сразу, задача и колокол РОП, текст причины не попал в `client_events` и `audit_log`;
  назначить не сотрудника отдела → `not_team_member`; назначить из `pending` → `accepted` + задача исполнителю;
  переназначить → та же задача у нового; РОП принимает → 404.

---

## 8. Тексты `messages/ru`

Ключи и тексты (ICU; без имён в шаблонах уведомлений):

```jsonc
// booking.json (добавить)
"duty": { "title": "Дежурство", "empty": "Сегодня вы не дежурите", "startsAt": "Начало в {time}",
  "unmarked": "Не отмечено: {count}", "attendedCount": "Пришли: {count}", "attended": "Пришёл", "noShow": "Не пришёл",
  "fixAttended": "Отметить «Пришёл»", "fixNoShow": "Отметить «Не пришёл»", "notStarted": "«Не пришёл» — после начала",
  "rest": "Остальные не пришли", "restConfirm": "Отметить «Не пришёл» у {count, plural, one {# гостя} other {# гостей}}?",
  "restDone": "Отмечено: {count}", "walkInRow": "Гость без записи", "changed": "Список изменился, обновили" },
"walkIn": { "title": "Гость без записи", "phone": "Номер телефона", "name": "Имя", "company": "Компания, если назвал",
  "submit": "Отметить гостя", "found": "Номер найден, гость отмечен", "new": "Новый гость, РОП назначит ответственного",
  "recorded": "Гость отмечен, РОП проверит" },
"events": { "title": "Мероприятия", "seats": "Мест: {taken} из {capacity}", "duty": "Дежурные", "setDuty": "Назначить дежурных",
  "noDuty": "Дежурит РОП", "cancel": "Отменить мероприятие",
  "cancelConfirm": "Отменить мероприятие? Записи станут «Отменена», операторы получат задачи «Перезаписать»." },
"consultants": { "title": "Консультанты", "add": "Добавить консультанта", "user": "Сотрудник", "directions": "Направления",
  "slot": "Слот, минут", "capacity": "Мест в слоте", "autoAssign": "Участвует в автоназначении", "sort": "Порядок",
  "inactive": "Выключен", "deactivate": "Выключить", "activate": "Включить", "schedule": "График", "noSchedule": "Общие часы",
  "exceptions": "Исключения", "dayOff": "Выходной", "customHours": "Особые часы", "conflicts": "Конфликты" },
"consult": { "suggested": "Записать к {name}", "reserve": "в резерв", "grey": "Назначим утром",
  "greyNextRun": "Консультанта подберём в ближайшие 30 минут", "greyTooLate": "Консультанта назначит РОП",
  "assign": "Назначить консультанта", "noCandidates": "На это время свободных консультантов нет" },
"consultations": { "title": "Мои консультации", "today": "Сегодня", "tomorrow": "Завтра", "later": "Позже",
  "unmarked": "Не отмечено", "hiddenClient": "Клиент откроется за день до встречи", "result": "Итог встречи",
  "note": "Что обсудили", "nextStep": "Следующий шаг", "toOffer": "Перевести в «Переговоры»", "bookNext": "Записать на следующую БК",
  "purchase": "Покупка", "empty": "Консультаций нет" },
"errors": { "slot_taken": "Это время уже занято. Выберите другое", "pool_full": "На это время некому принять заявку",
  "consultant_inactive": "Консультант выключен", "consultant_exists": "Этот сотрудник уже консультант",
  "schedule_overlap": "Окна графика пересекаются", "not_attended": "Сначала отметьте «Пришёл»",
  "walk_in_closed": "Гостей отмечают в день мероприятия", "walk_in_source_missing": "Нет источника «Пришёл без записи» в настройках",
  "phone_invalid": "Проверьте номер" }

// deals.json (новый)
{ "page": { "title": "Сделка", "stage": "Этап", "owner": "Ответственный", "history": "История", "bookings": "Записи",
    "handoff": "Передача в отдел", "needsRebook": "Нужна перезапись", "stale": "Залежалась {days} дн." },
  "purchase": { "title": "Покупка", "deal": "Сделка", "newDeal": "Новая сделка", "service": "Услуга", "amount": "Сумма, ₸",
    "date": "Дата", "submit": "Зарегистрировать", "done": "Покупка зарегистрирована", "handoff": "Передано в отдел «{team}»" },
  "outcomeFirst": "Сначала поставьте итог «Договорились» в карточке клиента",
  "actions": { "move": "Переместить в…", "lose": "Проигран", "editAmount": "Изменить сумму", "cancel": "Отменить покупку",
    "refund": "Возврат денег", "inputError": "Ошибка ввода", "comment": "Комментарий", "reason": "Причина", "reasonText": "Опишите причину" },
  "errors": { "deal_closed": "Сделка уже закрыта", "deal_not_won": "Покупки по сделке нет", "outcome_required": "Сначала итог «Договорились»",
    "request_reused": "Запрос устарел. Откройте форму заново", "service_type_unknown": "Выберите услугу",
    "amount_invalid": "Сумма — целое число тенге, не меньше нуля", "won_at_invalid": "Дата покупки не может быть так далеко",
    "next_step_required": "Добавьте следующий шаг с датой", "stage_fields_required": "Заполните поля этапа",
    "use_purchase": "Для покупки — кнопка «Покупка»", "use_lose": "Для проигрыша — кнопка «Проигран»",
    "reason_text_required": "Опишите причину", "service_type_locked": "Услугу так не поменять: отмените покупку как ошибку и зарегистрируйте заново" } }

// handoffs.json (новый)
{ "title": "Передачи", "tabs": { "pending": "Ждут", "accepted": "В работе", "closed": "Закрытые" }, "empty": "Передач нет",
  "seller": "Продал", "due": "Принять до {time}", "overdue": "Просрочено", "accept": "Принять", "assign": "Назначить исполнителя",
  "decline": "Отклонить", "declineReason": "Почему отклоняете", "assignee": "Исполнитель", "noAssignee": "Не назначен",
  "status": { "pending": "Ждёт", "accepted": "Принята", "declined": "Отклонена", "cancelled": "Отменена" },
  "errors": { "already_handled": "Передачу уже приняли или отклонили", "not_team_member": "Сотрудник не из отдела",
    "reason_required": "Укажите причину" } }
```

Паритет ключей и стоп-слова — общие тесты. Даты и время — `Intl` в `org.timezone`, локаль `ru` (`kk` позже).

## 9. Манифест изоляции

`tests/isolation/manifest/booking.ts` (добавить), `deals.ts`, `handoffs.ts` (новые). Все маршруты §2.3, §4.4,
§5.3, §7.1 и страницы: `/duty`, `/duty/[eventId]` (`idParam event`), `/bookings/events`, `/consultants`,
`/consultants/[id]`, `/bookings/consult-day`, `/consultations`, `/consultations/[bookingId]` (`idParam
booking`), `/deals/[dealId]` (`idParam deal`), `/deals/purchase/[cardId]` (`idParam card`), `/handoffs`,
`/handoffs/[id]` (`idParam handoff`). `touches`: `bookings`, `booking_history`, `client_events`, `deals`,
`handoffs`, `tasks`, `notifications`, `notes`, `resources`, `resource_schedule`, `resource_exceptions`,
`event_duty`, `phone_probes`, `clients`, `client_phones`, `contacts`, `client_sources`, `cards`, `audit_log`.

Обязательные строки прогона (сверх общих «A → 404 на объект B»):
- дежурный E1 сегодня: гости E1 — да; `no-show-rest`/`walk-in`/`attendance` на E2 или E1 завтра — 404; в HTML и
  JSON списка нет имени клиента гостя без записи; ответ `walk-in` без имени, id клиента и владельца;
- консультант C1: `/api/bookings/mine` без записей C2; `attendance`/`result` записи C2 — 404; клиент своей БК
  через 31 день — 404; запись к ресурсу C2 — 404;
- оператор: `consultants`, `consult-day`, `assign`, `purchase` — 403/404; сделка оператора B — 404;
- глава маркетинга: передача другого отдела — 404; после отказа — клиент 404; маркетолог: не назначенная — 404;
- директор: все мутации — 423;
- флаги `BK_WIZARD`/`PURCHASES` выключены → маршруты B5b/B5c/B6/B6b — 404 (отдельный прогон).

## 10. E2e (Playwright, проект `pixel-7`; `iphone-13` — тот же сценарий)

| Файл | Сценарий |
|---|---|
| `tests/e2e/booking-duty.spec.ts` (B4, к 26.10) | РОП с телефона: «Дежурство» → сегодняшний БР (сид: начался час назад, 5 гостей) → «Пришёл» у двух → «Остальные не пришли» с подтверждением → три «Не пришёл» → исправление одного на «Пришёл» → «Гость без записи» с номером клиента → «Номер найден» → строка «Гость без записи» без имени |
| `tests/e2e/booking-consult.spec.ts` (B5) | оператор: «Договорились» → БК → направление «Маркетинг» → предложен консультант → записан; консультант: «Мои консультации» → «Пришёл» → итог с шагом → «Переговоры» |
| `tests/e2e/deals-handoff.spec.ts` (B6/B6b) | консультант: «Покупка» SMM 450 000 ₸, двойное нажатие → одна сделка; глава маркетинга: «Передачи» → «Принять» → «Назначить исполнителя»; маркетолог видит передачу |

Сквозной Q1e (`tests/e2e/flow-*.spec.ts`) пишет `tester` на основе этих трёх.

## 11. Нужно от других (миграций нет)

| Что | Кому | Срок |
|---|---|---|
| `CONSULT_DAY_LOCK_CLASS = 72_026_107` в `src/server/platform/db/locks.ts` и `ALL_LOCK_VALUES` | platform (T0, координатор) | до B5b, 27.10 |
| `src/server/jobs/registry.ts`: `attendanceSweepJob`, `greyAssignJob` в `jobDefinitions()`; часть `invariants` `agreed_without_step` | координатор (T0) | с B4b / B5b |
| `notify/alarms.ts`: тревоги `alarm_deals_stale` (`countStaleDeals`) и `alarm_attendance_unmarked` (`countUnmarkedAttendance`) по образцу существующих; `notify.json`: тексты видов §1 («Новая передача в отдел», «Вам назначена передача», «Передача отклонена отделом», «Передача отменена», «Новая запись на БК», «Консультант назначен», «Запись из резерва стала основной», «Есть предложения консультантов», «Покупка зарегистрирована», «Сделки залежались: {count}», «Явка не отмечена: {count}») | manager | 28.10 |
| Назначение руководителя отдела (`teams.lead_user_id`) — экран «Команда» или `crmctl team set-lead`; приглашение маркетолога с `team_id` | manager (R2b) | 29.10 |
| Карточка клиента C8: ссылки «Покупка» → `/deals/purchase/<cardId>` (если `can(v,'deal.purchase')` и флаг) и сделки → `/deals/<dealId>` | calling | 28.10 |
| `PLAN.md` §2: статические сегменты `/api/bookings/{consultants,consult-day,mine}` — зона booking (в списке уже `api/bookings/**`) — правка не нужна; отметить B5a в §4 «Вс 25.10» | координатор | 24.10 |

## 12. Разбивка и порядок

| № | Задача | Ур. | Кто | Когда | Зависит |
|---|---|---|---|---|---|
| 0 | `booking/types.ts`: союз `BookingCardEvent` + 4 события (§1); `AUDIT_ACTIONS`/`AuditEntity` (§1); `messages/ru/booking.json` §8 (duty, walkIn, events); заготовки манифестов | T0 | mechanic | Сб 24.10 вечер | этот дизайн |
| B4-1 | `opsSettings.ts`, `duty.ts` (`listDutyEvents`, `markRestNoShow`, кандидаты), маска гостей, закрытие «Отметьте явку» в `changeStatus`, маршруты, тесты `rest-no-show`, `guests-mask`, `duty-events` | T1 | builder | Вс 25.10 | 0 |
| B4-2 | `walkIn.ts` + SQL нового клиента + маршрут + `walk-in.test.ts` | T1 | builder (второй) | Вс 25.10 | 0 |
| B4-3 | экраны `/duty`, `/duty/[eventId]` (лист гостя, диалог), e2e `booking-duty.spec.ts` | T1 | builder | Вс 25.10 → Пн 26.10 10:00 | B4-1, B4-2 |
| B4-4 | `/bookings/events` (места, дежурные, отмена) | T1 | builder | Пн 26.10 до 12:00, иначе `0.9.1` | B4-1 |
| B5a | `consultants.ts` (список, создать, править, выключить) + API + `/consultants` + тест | T1 | builder | Вс 25.10 | 0 |
| R-1 | ревью B4 и B5a (охваты, утечка в гостях, блокировки приёма) | T2 | reviewer | Пн 26.10 до 11:30 | B4-*, B5a |
| B5b | `consultDay.ts`, ветка `individual` в `bookings.ts`, `assign.ts`, `greyJob.ts`, тесты §4.10 (`consult-place`, `consult-race`, `assign`, `grey-job`) | T2→T1 | builder (по этому дизайну) | Вт 27.10 | B5a, locks |
| B5c | график и исключения (API и экран), `consultations.ts`, экраны консультанта, `ConsultStep` за флагом, e2e `booking-consult` | T1 | builder | Вт 27.10 | B5b |
| R-2 | ревью B5b (блокировка дня, гонки, пул «серых») | T2 | reviewer | Вт 27.10 | B5b |
| B4b | `sweep.ts`, `jobs.ts`, `deals/stale.ts`, тесты §3.7; регистрация (координатор) | T1 | builder | Ср 28.10 | B4 |
| B6-1 | `deals/settings.ts`, `rules.ts` + unit; `effects.ts` (4 операции); `handoffs/create.ts` | T1 | builder | Ср 28.10 | 0 |
| B6-2 | `purchase.ts`, `stage.ts`, `read.ts`, маршруты, тесты §5.10 | T2→T1 | builder | Ср 28.10 | B6-1 |
| B6-3 | экраны `/deals/[dealId]`, `/deals/purchase/[cardId]`, `deals.json` | T1 | builder | Ср 28.10 → Чт 29.10 | B6-2 |
| R-3 | ревью денег и идемпотентности покупки, отмены, передачи | T2 | reviewer | Чт 29.10 утро | B6-* |
| B6b | `handoffs/{inbox,actions}.ts`, API, экраны, `handoffs.json`, тесты §7.5, e2e `deals-handoff` | T1 | builder | Чт 29.10 | B6 |
| Q | манифесты §9 и прогон изоляции на двух пресетах | T1 | tester | после каждой части | — |

**В пилот (заморозка Пн 26.10 12:00, `0.9.0`):** 0, B4-1…B4-3, B5a; B4-4 — если успевает, иначе `0.9.1`
(дежурит РОП своим охватом, назначать дежурных для первого БР не обязательно). Крайний срок дежурства на бою —
репетиция Ср 28.10 17:00. **К 01.11:** B5b, B5c, B4b, B6, B6b. При отставании внутри потока — сначала уходит
на неделю 2 экран графика (B5c: консультанты работают по общим часам `booking.consult.hours`), затем режим
`suggest` автоназначения; покупка, передача и `attendance-sweep` не режутся.

## 13. Вопросы владельцу

1. **Передача, а руководитель отдела не назначен (PROCESS 12.30).** Рекомендую: задача РОП «Назначьте
   руководителя отдела», передача ждёт (D-250). Вариант PROCESS — задача каждому сотруднику отдела — не
   работает: принять передачу может только руководитель (отношение `handoff_to_my_team`).
2. **Видит ли отдел сумму покупки?** Рекомендую: нет — отделу нужны услуга, дата и кто продал; сумма
   остаётся у РОП и директора (меньше коммерческих данных в чужом отделе). До ответа действует D-300: по
   отношениям передачи видна только сделка передачи, без суммы и денежных полей истории.
3. **Имена клиентов будущих БК у консультанта.** Рекомендую: как в PROCESS 8.4 — только с дня перед встречей;
   дальше консультант видит время и направление (D-246). Если консультантам нужно готовиться за неделю —
   меняется параметр роли `fromDays`, код тот же.
