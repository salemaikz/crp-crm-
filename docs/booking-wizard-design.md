# Мастер записи и минимальная заявка на БК — дизайн B3a для builder

Нормативно для B3a: решения D-201…D-205 (`docs/DECISIONS.md`). Опирается на `docs/booking-design.md`
(B2: модель, блокировки, ошибки §10 — не повторяются здесь), `docs/calls-design.md` §4.3 (итог
«Договорились — записать»), PROCESS §2.7, §5.1–5.2, §6.2, 12.7, 12.18; ARCHITECTURE §7; CONFIG §6.9;
D-019, D-042, D-049, D-131…D-137. Ядро — только корень `@crm/core` (D-101).

Новые типы и сигнатуры — в конце `src/server/domain/booking/types.ts` (блок «B3a»). Builder их реализует
и не меняет; **одна разрешённая правка** существующего типа — §3.

## 1. Что делаем и чего нет

| Есть в B3a | Нет в B3a (кто) |
|---|---|
| мастер на странице `/bookings/new/<cardId>` и как компонент для шторки итога | шторка итога, outbox (C7a/C7b) |
| БР: ближайшее мероприятие с местами, 2 нажатия, «Другая дата», повтор = перенос | перенос мероприятия, напоминания (B3b) |
| БК: направление → день → время → «Без консультанта», «серая» заявка | консультанты, графики, подбор, автоназначение, резерв (B5, `FEATURE_BK_WIZARD`) |
| минимальные «Записи» `/bookings`: только чтение | действия, фильтры, вид РОП, плитка «серых» (B3b, R1a) |
| новая запись закрывает задачи «записать» клиента (D-204) | — |

Флаг не нужен: минимальная заявка на БК — без флага (PLAN, таблица флагов).

## 2. Связь с итогом «Договорились» (D-202)

Два пути, оба — одна транзакция на сервере:

| Откуда | Состояние карточки | Что уходит на сервер | Кто проверяет |
|---|---|---|---|
| **A. Шторка итога** (C7a): «Договорились» → ЛПР, ниша, контакт → мастер в той же шторке | любое рабочее | `POST /api/calls/outcomes` с `agreement.booking` (уже есть в C5, §4.3): итог + запись + сделка, `requestId = opId` | C5 + `createBooking(…, { fromOutcome })` |
| **B. Страница мастера** (из карточки клиента, задачи, «Записей») | `agreed` или `client` | `POST /api/bookings` | `createBooking` (B2 §5.1) |

- Страница с карточкой не в `agreed`/`client` (`mode = 'outcome_required'`) не показывает вкладки: `Alert`
  «Сначала итог «Договорились»» и одна кнопка «К карточке клиента» (`/clients/<clientId>`). Итог с полями
  (ЛПР, ниша) собирает только шторка — второй формы итога нет.
- `409 outcome_required` на пути B (карточку успели перевести: «Не пришёл», чужой итог) — тот же экран.
- «Договорились, запишу позже» (`agreedDueAt`, задача `agreement:<opId>`) — кнопка шторки (C7a). Запись
  через страницу потом закрывает эту задачу (D-204).
- Путь A и `fact_only` (карточку передали): ответ `bookingId: null` — шторка говорит «Карточка передана.
  Итог сохранён в истории» (C7a). Отказ ядра (`400 lpr_required` и т. п.) — тоже шторка.

## 3. Настройки: `BookingSettings.catalog` (единственная правка существующего типа)

Builder добавляет в `interface BookingSettings` одно поле **`catalog: BookingCatalog`** и разбирает его в
`parseBookingSettings` (свой Zod, `.passthrough()` как сейчас):

| Поле каталога | Источник | Если нет |
|---|---|---|
| `eventTypes[]` (все виды, порядок настроек) | `booking.eventTypes[]`: `key, behavior, label, short, durationMin, directions[] = []` | пусто |
| `directions[]` | `booking.directions[]` `{key, label}` | пусто |
| `consult.slotMinutes`, `consult.hours`, `consult.stripDays` | `booking.consult.slotMinutes`, `booking.consult.hours`, `booking.consultStripDays` | ошибка схемы → `invalid_settings` |

`label`/`short` — `{ ru, kk? }`; выбор на языке зрителя: локаль `kz` → `kk ?? ru`, иначе `ru` (D-002).
Тестовые настройки (`tests/integration/booking/helpers.ts` → `testSettings()`) получают каталог ЦРП:
`br` group «Бизнес-разбор»/«БР», `bk` individual «Бизнес-консультация»/«БК» 45 мин, 6 направлений, часы
пн–пт 09:00–18:00, шаг 45, полоса 7.

## 4. Заявка на консультацию: `createBooking` с `kind: 'individual'` (D-203)

`IndividualBookingRequest` (уже в типах). В B3a `resourceId` — только `null`; не `null` → `throw new
Error('B5')` (ошибка сборки; маршрут это и так не пропустит). Общий путь `placeInTx` разветвляется на шаге 5.

```
1. карточка FOR UPDATE со scopeSql(v,'card','booking.create') (fromOutcome — без блокировки, как B2)
2. повтор requestId: есть строка → тот же clientId И kind='individual' И (eventTypeKey, date, time,
   directionKey) совпали → replayResult; иначе request_reused
3. состояние карточки ∉ (agreed, client) и не fromOutcome/imported → outcome_required
4. контакт клиента (как B2)
5. вид: settings.catalog.eventTypes[key].behavior = 'individual', иначе not_an_individual_event (409)
   направление: ∈ catalog.directions И (type.directions пуст ИЛИ содержит) → иначе BadRequestError('direction')
   день: date ∈ [сегодня, сегодня + horizonDays] в org.timezone, иначе outside_hours (409)
   время: plan = booking.defaultHoursDay(date, consult.hours, calendar.isWorkday);
          timeToMin(time) ∈ booking.slotStarts(plan, consult.slotMinutes), иначе outside_hours
   startsAt = booking.localToEpoch(tz, date, time); startsAt ≤ now → slot_in_past (409)
6. записи клиента FOR UPDATE (как B2 §5.1 шаг 7) → booking.resolveRepeatBooking(…, { eventTypeKey, eventId: null }):
   move и у старой та же (date, time, directionKey) → already_registered; move → перенос; create → новая
7. мест не считаем (графиков и вместимости нет — PROCESS 5.2 «в пилот»), блокировки консультанта нет (B5)
8. сделка: from ? from.dealId : deps.deals.ensureOpen(…) — как B2
9. INSERT bookings: kind 'individual', event_id NULL, resource_id NULL, booking_date = date,
   start_time = time, starts_at, duration_min = type.durationMin, direction_key, is_reserve FALSE,
   status 'registered', via, booked_by (перенос — из старой), responsible = card.ownerUserId,
   moved_from_id, request_id, import_key, version 0
   ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING RETURNING *
10. перенос: markMoved старой, история обеих, лента booking.moved {fromId, toId, fromEventId: null, toEventId: null}
    новая: история 'created' meta {requestId, via, grey: true}; лента booking.created
    {bookingId, eventId: null, eventTypeKey, eventDate, startTime, via, directionKey}
11. закрыть задачи (D-204, §5)
```

Вставку пишет новая функция `repo.insertIndividualBooking` (весь SQL — в `repo.ts`). Полоса для мастера —
чистая `consultDays: ConsultDays` в `booking/consult.ts`: `consult.stripDays` ближайших рабочих дней
(`calendar.isWorkday` и `consult.hours.workdays`), у каждого — `slotStarts` в `HH:MM`, у сегодняшнего —
только `> now`; день без слотов пропускается. Шаг 5 и полоса — одна функция проверки слота, чтобы мастер
никогда не предлагал то, что сервер отклонит.

Статусы, отмена, подтверждение, `cancel_future`, `reassign_future` — общий код B2, от `kind` не зависят.
`/api/bookings/[id]/move` в B3a — только групповые (перенос заявки — повторная запись через мастер).

## 5. Новая запись закрывает задачи «записать» (D-204)

В `placeInTx` после истории и ленты (оба вида, создание и перенос; не при `imported`):
`closeAutoTasks(tx, actor, { spaceId, clientId, sources: BOOKING_CLOSES_TASK_SOURCES, at: now })` из
`src/server/domain/tasks/auto.ts` (импорт; файл не правим). Источники: `agreement`, `next_step`, `rebook`,
`no_show`, `clarify_import` — PROCESS 6.2 «закрывается при новой записи». Карточку не трогаем (D-133).

## 6. API

| Метод и путь | Есть? | Право / цель | Тело или запрос | Ответ |
|---|---|---|---|---|
| `GET /api/bookings/wizard/[cardId]` | **новый** | `booking.create` / object `card` | — (`locale` — из запроса next-intl) | `BookingWizardView` |
| `POST /api/bookings` | B2, **расширить Zod** | `booking.create` / section | `GroupBookingBody` **или** `IndividualBookingBody` (§6.1) | `CreateBookingResult` 201 / 200 |
| `GET /api/events/offer?clientId&type` | B2 | `booking.create` / section | — | `OfferResult` — освежить БР после `event_cancelled`, `already_registered` |
| `POST /api/bookings/[id]/cancel` | B2 | `booking.create` / object `booking` | `{ opId, version, reason: 'operator_error' }` | «Отменить» в тосте |
| `POST /api/calls/outcomes` | C5 | `card.outcome` | `agreement.booking` = `AgreementBookingBody` (§6.1) | путь A |

### 6.1. Схемы в `src/app/api/bookings/_lib.ts`

```ts
export const IndividualBookingBody = z.object({
  kind: z.literal('individual'), requestId: opId, clientId: id, eventTypeKey: id, date, time,
  directionKey: id, resourceId: z.null(), contactId: id.nullable().default(null),
}).strict();
export const BookingBody = z.discriminatedUnion('kind', [GroupBookingBody, IndividualBookingBody]);
/** Запись внутри итога: без requestId, clientId, contactId — их ставит сервер (calls-design §4.3). */
export const AgreementBookingBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), eventId: id }).strict(),
  IndividualBookingBody.omit({ requestId: true, clientId: true, contactId: true }).strict(),
]);
```

`POST /api/bookings` читает `BookingBody`. `calls/_lib.ts` (зона calling) заменяет свою `AgreementBooking`
на импорт `AgreementBookingBody` — одна строка, запрос в §11.

### 6.2. `getBookingWizard` (`booking/wizard.ts`)

`requireRole(v,'booking.create','object')` → в одной транзакции чтения: карточка + `clients.name` со
`scopeSql(v,'card','booking.create')` (нет → `NotFoundError`) → `settings` → `types` из `catalog` с подписями
→ для каждого группового вида — то же, что `offerEvents` (вынести общее тело в функцию с `tx`), для
каждого индивидуального — `consultDays` + направления + `current` (активная будущая того же вида) →
`mode`. Без `custom`, номеров и контактов.

## 7. Экран мастера (оператор, телефон)

Файлы: `src/app/(op)/bookings/new/[cardId]/page.tsx` (`page({ perm: 'booking.create' })`, данные —
`getBookingWizard` на сервере, без лишнего запроса); компонент `src/app/(op)/bookings/_wizard/`:

| Файл | Что |
|---|---|
| `BookingWizard.tsx` (`'use client'`) | вкладки, шаги, подтверждение, ошибки; пропсы ниже |
| `GroupStep.tsx`, `ConsultStep.tsx`, `ConfirmStep.tsx`, `DoneStep.tsx` | шаги (≤ 150 строк каждый) |
| `choice.ts` | `WizardChoice`, `toBookingBody(view, choice, requestId)`, `toAgreementBooking(choice)` — для шторки |
| `result.ts` | разбор ответа: 201/200 → `ok`; 409 `{detail}` → код; `event_full` → `alternatives`; сеть → `network` |
| `format.ts` | дата и время в `view.timeZone` (`Intl`, `kk` для казахского) |

```ts
type WizardChoice =
  | { kind: 'group'; eventTypeKey: string; event: EventOption }
  | { kind: 'individual'; eventTypeKey: string; directionKey: string; date: string; time: string };
type WizardSubmit = (choice: WizardChoice, requestId: string) => Promise<WizardResult>;
type WizardResult =
  | { ok: true; booking: BookingView; action: 'created' | 'moved' }
  | { ok: false; code: 'event_full'; alternatives: EventOption[] }
  | { ok: false; code: BookingDomainErrorCode | 'network' | 'handled' };   // handled — ошибку показал хозяин
interface BookingWizardProps {
  view: BookingWizardView;
  /** Нет — путь B (`POST /api/bookings`). Шторка C7a передаёт отправку итога с `agreement.booking`. */
  submit?: WizardSubmit;
  onDone?: (r: { booking: BookingView; action: 'created' | 'moved' }) => void;
}
```

### 7.1. Вкладки

Одна вкладка на вид из `view.types` (`Tabs`); текст вкладки — `short` (у ЦРП «БР», «БК»), если пусто —
`label`; заголовок панели — `label`. Один вид — без вкладок. Порядок — настройки (D-205).

### 7.2. БР — два нажатия

1. Сверху — ближайшее мероприятие (`options[0]`, кроме того, на которое клиент уже записан): «чт, 29 окт.,
   15:00», место или «Онлайн», `Badge` «Осталось 12 мест из 30». Есть `current` — строка «Сейчас: чт, 22 окт., 15:00».
2. Главная кнопка (одна на экран, 44 px+): «Записать на чт, 29 окт.» / «Перенести на чт, 29 окт.» → **нажатие 1**.
3. Ниже ссылка «Другая дата» → `List` остальных вариантов; нажатие на строку = нажатие 1.
4. Подтверждение на месте (не вторая модалка): «Записать ТОО «Альфа» на БР чт, 29 окт., 15:00?» или
   «Перенести запись ТОО «Альфа» с чт, 22 окт. на чт, 29 окт.?»; кнопки «Подтвердить» (**нажатие 2**) и «Назад».
5. Нет вариантов — `EmptyState` «Нет мероприятий со свободными местами на ближайшие {days} дней».

### 7.3. БК — минимальная заявка

`ChipGroup` направлений (одно — выбрано сразу) → `ChipGroup` дней `view.consultOffers[].days` («пн 26»)
→ `ChipGroup` времени дня → строка «Консультант: без консультанта — назначит руководитель» (не кнопка) →
главная кнопка «Оставить заявку на пн, 26 окт., 09:45» → подтверждение «Записать ТОО «Альфа» на БК
пн, 26 окт., 09:45, направление «Маркетинг»? Консультанта назначит руководитель.» → «Подтвердить».
Нет дней — `EmptyState` «Нет свободного времени на ближайшие дни». `current` — «Сейчас: …», кнопка «Перенести на …».

### 7.4. Ключ запроса, ошибки и гонка (D-205)

- `requestId = crypto.randomUUID()` при открытии мастера; **не меняется** после ошибок и сбоя сети
  (повтор того же выбора → `replayed`); новый — только после успеха. Кнопка блокируется на время запроса.
- `409 event_full` (последнее место заняли): подтверждение заменяется `Alert` «Мест на чт, 29 окт. не
  осталось. Выберите другую дату.» и списком `alternatives` из ответа; выбор → снова подтверждение. Пустой
  список — `EmptyState` из 7.2. Путь A: транзакция итога откатилась, тот же `opId` переиспользуется.
- `event_cancelled`, `event_in_past`, `already_registered` → текст из `booking.errors.*` и перезапрос
  `GET /api/events/offer` (новые варианты и `current`).
- `outcome_required` → экран §2. `request_reused` → перезапрос мастера, новый `requestId`, текст ошибки.
- `outside_hours`, `slot_in_past` (БК: время прошло, пока выбирали) → текст + перезапрос мастера.
- Сеть / 5xx → `Alert` «Нет связи. Запись не отправлена.» + «Повторить» (тот же ключ).
- 423 (только чтение лицензии) — обёртка; текст `common`.

### 7.5. Успех

`Toast` (success) «Записан: БР, чт, 29 окт., 15:00» / «Перенесено: …» / «Заявка: БК, пн, 26 окт., 09:45.
Консультанта назначит руководитель» с `undo` «Отменить» → `POST /api/bookings/[id]/cancel`
`{ opId: новый, version, reason: 'operator_error' }` (окно 10 мин и автор — сервер, 12.7) → тост «Запись
отменена». Экран — `DoneStep` с главной кнопкой «К карточке клиента» и ссылкой «Записи». В шторке — `onDone`.

## 8. Минимальные «Записи»

`src/app/(op)/bookings/page.tsx` — `page({ perm: 'booking.read' })`, оболочка по роли (`RoleShell` из
layout `(op)`), `listBookingItems(viewer, { from: сегодня, to: сегодня + horizonDays, status:
['registered','confirmed'] })` — `booking/list.ts` + `repo.listBookingItemRows` (охват записи, JOIN
`clients` за `name`, ≤ 200 строк, по `starts_at`). Группы по дате («Сегодня», «Завтра», «чт, 29 окт.»);
строка `ListItem`: «15:00 · БР · ТОО «Альфа»», `Badge` статуса, у «серых» — `Badge` «Без консультанта»;
строка ведёт на `/clients/<clientId>`. Пусто — `EmptyState` «Записей на ближайшие дни нет». B3b
расширяет этот файл.

## 9. Тексты (`messages/ru/booking.json`, ключи `wizard.*`, `list.*`)

```json
"wizard": {
  "title": "Запись", "current": "Сейчас: {when}", "nearest": "Ближайшее",
  "seatsLeft": "{left, plural, one {Осталось # место} few {Осталось # места} many {Осталось # мест} other {Осталось # места}} из {capacity}",
  "online": "Онлайн", "bookOn": "Записать на {when}", "moveOn": "Перенести на {when}", "otherDate": "Другая дата",
  "confirmBook": "Записать {client} на {type} {when}?", "confirmMove": "Перенести запись {client} с {from} на {to}?",
  "confirm": "Подтвердить", "back": "Назад",
  "noEvents": "Нет мероприятий со свободными местами на ближайшие {days} дней",
  "full": "Мест на {when} не осталось. Выберите другую дату.",
  "direction": "Направление", "day": "День", "time": "Время", "consultant": "Консультант",
  "noConsultant": "Без консультанта — назначит руководитель",
  "requestOn": "Оставить заявку на {when}",
  "confirmRequest": "Записать {client} на {type} {when}, направление «{direction}»? Консультанта назначит руководитель.",
  "noSlots": "Нет свободного времени на ближайшие дни",
  "doneCreated": "Записан: {type}, {when}", "doneMoved": "Перенесено: {type}, {when}",
  "doneRequest": "Заявка: {type}, {when}. Консультанта назначит руководитель",
  "undo": "Отменить", "undone": "Запись отменена",
  "outcomeRequiredTitle": "Сначала итог «Договорились»",
  "outcomeRequiredText": "Записать клиента можно после итога звонка «Договорились».",
  "toClient": "К карточке клиента", "toBookings": "Записи",
  "network": "Нет связи. Запись не отправлена.", "retry": "Повторить"
},
"list": { "title": "Записи", "empty": "Записей на ближайшие дни нет", "grey": "Без консультанта", "today": "Сегодня", "tomorrow": "Завтра" }
```

`errors.*` дополнить: `outside_hours` «Это время недоступно. Выберите другое.», `slot_in_past` «Это время уже
прошло.», `not_an_individual_event` = текст `invalid_settings`. Имена видов и направлений — только из настроек.

## 10. Тесты

**Unit** (`tests/unit/booking/`): `settings.test.ts` — каталог пресета ЦРП и `base` (пусто), `kk`-подпись;
`consult.test.ts` — `consultDays`: 7 рабочих дней, праздник 26.10.2026 пропущен, сегодня в 12:10 первый слот
12:45, последний 17:15, день без слотов пропущен, проверка слота = полоса; `wizard-choice.test.ts` — `toBookingBody`,
`toAgreementBooking`, разбор ответов `result.ts` (201, 200 replayed, 409 event_full с альтернативами, 409 код,
сеть). Паритет `messages` — существующий тест.

**Интеграционные** (`tests/integration/booking/`, Postgres 16, часы в `deps`):
- `consult.test.ts` — «серая» заявка на `agreed`: строка (`kind`, `resource_id NULL`, `event_id NULL`,
  `direction_key`, 45 мин, `starts_at` по Asia/Almaty), история `grey: true`, лента, `deal_id`;
  `callback` → `outcome_required`; `fromOutcome` проходит; чужой вид → `not_an_individual_event`; чужое
  направление → 400; суббота и 26.10 → `outside_hours`; 09:20 → `outside_hours`; прошедший слот →
  `slot_in_past`; дальше горизонта → `outside_hours`; повтор ключа → `replayed`, одна строка; тот же ключ на
  другой слот → `request_reused`; вторая заявка другим ключом → перенос (`moved`, `booked_by` исходной,
  `deal_id` тот же); тот же слот → `already_registered`; БР и БК независимы; отмена `operator_error` автором
  ≤ 10 мин; `resourceId` не `null` → `Error('B5')`. Тест B2 «individual → /B3a/» заменить этим.
- `wizard.test.ts` — `mode` по состоянию; вкладки в порядке настроек с подписями; БР: 3 ближайших с местами,
  полное пропущено, `current`; БК: дни и направления; чужая карточка → `NotFoundError` (как несуществующая);
  консультант (`booked_with_me`) → 404.
- `tasks-close.test.ts` — `agreement:<opId>` закрыта записью на БР; `next_step` у `client` закрыта заявкой
  на БК; импорт задачи не закрывает; чужие клиенты не затронуты.
- `outcome-link.test.ts` — `submitOutcome` с `agreement.booking` индивидуальной: одна транзакция (`calls`,
  «серая», сделка); `outside_hours` в итоге → 409, ни строки `calls`, ни записи; групповой `event_full` в итоге
  → 409 с альтернативами, повтор тем же `opId` на другое мероприятие → успех.
- `list.test.ts` — оператор видит только своих с `clientName`, `grey`; РОП — всех; отменённые не в списке.
- `isolation.test.ts` (+): `GET /api/bookings/wizard/<карточка B>` от A → 404 байт в байт как несуществующий;
  `POST /api/bookings` individual с клиентом B → 404, таблицы не изменились; тело с `resourceId` строкой → 400.
  Существующую строку «`kind: 'individual'` → 400» заменить на `resourceId: 'r1'`.

**Манифест** `tests/isolation/manifest/booking.ts` (+3): route `GET /api/bookings/wizard/[cardId]`
(`idParam { name: 'cardId', entity: 'card' }`); page `/(op)/bookings/new/[cardId]` (то же `idParam`, в HTML
у A нет названия клиента B); page `/(op)/bookings` (section). `POST /api/bookings` — добавить пример
индивидуального тела не нужно (манифест — один пример на вход).

**E2E** `tests/e2e/booking-wizard.spec.ts` — проекты `pixel-7` и `iphone-13` (запуск — `pixel-7`), своя БД
(миграции, ревизия пресета ЦРП, синтетика: оператор, ТОО «Тест Альфа» +7 709 …, БР на ближайший четверг):
1. **итог «Договорились» → мастер → запись → видна в карточке и в «Записях»**: итог через
   `page.request.post('/api/calls/outcomes')` (ЛПР, ниша, `agreedDueAt` — шторки ещё нет) → `/bookings/new/<cardId>`
   → вкладка «БР», «Осталось 30 мест из 30» → «Записать на …» → «Подтвердить» → тост с «Отменить» →
   `/clients/<clientId>`: в ленте «Запись на мероприятие» → `/bookings`: строка «ТОО «Тест Альфа»», «Записан»;
   в БД задача `agreement:<opId>` закрыта.
2. повтор = перенос: снова мастер → «Сейчас: …» → «Перенести на …» → «Подтвердить» → «Перенесено».
3. гонка за последнее место: вместимость = занято + 1, мастер открыт, SQL занимает место → «Подтвердить» →
   «Мест … не осталось» и альтернативы → выбор → успех.
4. БК: «БК» → «Маркетинг» → первый день → первое время → «Оставить заявку…» → «Подтвердить» → в «Записях»
   «Без консультанта».
5. карточка в `callback`: экран «Сначала итог «Договорились»», кнопки «Подтвердить» нет.
Во всех: цели ≥ 44 px у главных кнопок и чипов, нет горизонтальной прокрутки на 412 px.
Сквозной путь через шторку (путь A) — `tests/e2e/flow-agree-book.spec.ts` у tester после C7a.

## 11. Нужно от других

| Что | Кому | Когда |
|---|---|---|
| `src/app/api/calls/_lib.ts`: `AgreementBooking` → `import { AgreementBookingBody } from '../bookings/_lib'` | calling (C5/C7a) | после влития B3a |
| шторка: «Договорились» → ЛПР/ниша/контакт → `<BookingWizard view submit onDone>` в той же шторке; `submit` = `POST /api/calls/outcomes` с `agreement.booking = toAgreementBooking(choice)`, `opId = requestId`; кнопка «Запишу позже» (`agreedDueAt`) | calling (C7a) | 23.10 |
| карточка клиента: кнопка «Записать» → `/bookings/new/<cardId>` при `agreed`/`client` | calling (C8) | 24.10 |
| e2e пути A через шторку | tester | после C7a |

## 12. Разбивка работ

| № | Задача | Уровень | Кто |
|---|---|---|---|
| 1 | `catalog` в `BookingSettings` + `settings.ts` + `testSettings()` + unit | T1 | builder |
| 2 | `consult.ts` (`consultDays`, проверка слота) + unit | T1 | builder |
| 3 | ветка `individual` в `bookings.ts`, `repo.insertIndividualBooking`, закрытие задач (§4–5) + `consult`, `tasks-close`, `outcome-link` | T2→T1 (по этому дизайну) | builder |
| 4 | `wizard.ts`, `list.ts`, repo-чтения, маршрут `wizard/[cardId]`, Zod §6.1, манифест, `wizard`, `list`, `isolation` | T1 | builder |
| 5 | тексты §9 | T0 | mechanic |
| 6 | UI мастера §7 и «Записи» §8 + unit `wizard-choice` | T1 | builder |
| 7 | e2e §10 (pixel-7) | T1 | tester |
| 8 | ревью блокировок, охвата `wizard/[cardId]`, закрытия задач | T2 | reviewer |
