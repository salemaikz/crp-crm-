# Запись на групповые мероприятия — дизайн B2 для builder

Нормативно для B2: решения D-131…D-137 (`docs/DECISIONS.md`). Опирается на PROCESS §3.5 (№ 9, 16–18, 28,
31), §4.1–4.2, §5.1, §5.3, §5.5, §5.6, §8.2–8.3, §12.7, 12.18, 12.19, 12.26, 12.40; ARCHITECTURE §5; CONFIG
§6.8–6.9; D-042, D-049, D-050, D-071…D-075; схему v1 (`event_series`, `events`, `event_duty`, `bookings`,
`booking_history`, `deals`, `client_events`). Ядро — `import { booking, calling, time } from '@crm/core'`
(только корень).

Сигнатуры уже в коде: `src/server/domain/booking/types.ts`. Builder реализует их и **не меняет**
(нужна правка — через architect). Консультации, «серые» заявки (B3a/B5), гость без записи (B4),
`attendance-sweep` (B4b) в B2 не реализуются, но модель и типы их допускают.

## 1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/booking/types.ts` | контракт (готов) |
| `booking/errors.ts` | `class BookingDomainError extends Error { code; alternatives? }` (форма `BookingFailure`); `fromCore(e: booking.BookingError)` |
| `booking/settings.ts` | `loadBookingSettings: LoadBookingSettings` — свой Zod поверх `getActiveConfig()`: `booking.*`, `pipelines[]` (этапы `auto`), `calendar.*` + `org.timezone` → `time.createWorkCalendar` |
| `booking/tx.ts` | `inBookingTx(opts, fn)`: есть `opts.tx` — выполнить в нём; нет — `getDb().tx` с повтором до 3 раз на `40P01`/`40001` |
| `booking/repo.ts` | весь SQL модуля (§5): блокировки, места, записи, история, лента `booking.*`, мероприятия, серии, дежурные, гости |
| `booking/series.ts` | `listSeries`, `createSeries`, `updateSeries`, `syncSeries`, `ensureAllSeries` |
| `booking/events.ts` | `offerEvents`, `listEvents`, `getEvent`, `createEvent`, `updateEvent`, `cancelEvent`, `setEventDuty`, `listGuests` |
| `booking/bookings.ts` | `createBooking`, `moveBooking`, `setConfirmation`, `markAttendance`, `cancelBooking`, `getBooking`, `listBookings` |
| `booking/effects.ts` | `applyBookingEffects: ApplyBookingEffects` (`cancel_future`, `reassign_future`) для исполнителя эффектов карточки |
| `booking/cardPort.ts` | `unavailableCardPort` (бросает `card_port_unavailable`) до C5 |
| `booking/deps.ts` | `bookingDeps(): BookingDeps` — `cards`, `deals`, `settings`, `now`. После C5 координатор меняет одну строку: `cards` = порт из `src/server/domain/cards/bookingPort.ts` |
| `booking/index.ts` | реэкспорт сервисов и типов (не repo) |
| `src/server/domain/deals/repo.ts`, `deals/effects.ts` | минимум сделок для записи (§7.3): `dealLink: DealLink`, `applyDealEffects(tx, actor, card, effects.deals, at)` для C5 |
| `src/app/api/events/**`, `src/app/api/bookings/**` | маршруты (§4); `src/app/api/bookings/_lib.ts` — Zod тел, ошибка → ответ (§10) |
| `tests/isolation/manifest/booking.ts` | манифест всех маршрутов §4 |
| `tests/integration/booking/*.test.ts`, `tests/integration/deals/effects.test.ts`, `tests/unit/booking/*.test.ts` | §11 |
| `messages/ru/booking.json` | тексты кодов ошибок §10 для B3a (нейтрально, без имени клиента) |

## 2. Модель и инварианты

- **Места держат** `registered | confirmed | attended | no_show` (`booking.OCCUPYING_STATUSES`). Отмена и
  перенос место освобождают. Вместимость — `events.capacity`; занято = `COUNT(*)` записей события в этих
  статусах. Счётчика в `events` нет (D-131).
- **Активная** запись — `registered | confirmed`. У клиента в пространстве не больше одной активной
  **будущей** записи на вид мероприятия: повторная запись = перенос (`booking.resolveRepeatBooking`, D-042).
  Проверка — под блокировкой карточки (12.18), индекс `bookings_group_uq` — второй рубеж.
- **Заслуга** `booked_by_user_id` = кто записал (`viewer.userId`); перенос копирует её из исходной записи;
  импорт — из колонки (C4b), система — `NULL`. **Ответственный** `responsible_user_id` = `cards.owner_user_id`
  на момент записи; меняет только передача клиента (`reassign_future`).
- **Сделка**: при создании записи `deal_id` = открытая сделка клиента в воронке с `createDealOn: agreed`
  (или новая на этапе `auto = on_agreed`); перенос сохраняет `deal_id` исходной (D-134).
- **Карточка** не меняется SQL-ем модуля записи. Новая запись — только для карточки в `agreed` или `client`;
  иначе `outcome_required` и интерфейс открывает итог «Договорились» (C5 вызовет `createBooking` с
  `fromOutcome`). Последствия статусов — события карточки через `CardPort` (D-133, §7).
- **Мероприятие**: `scheduled | cancelled`. «Снятое» синхронизацией серии — `series_id IS NOT NULL AND
  occurrence_key IS NULL AND status = 'cancelled'`; в списках не показывается (D-135). Разовое — `series_id
  NULL`, `occurrence_key NULL`, `id` = ключ запроса.
- **Формат** `offline | online` (Zod; `''` только у старых строк). Место и формат разового мероприятия по
  умолчанию — из активной серии того же вида (последняя по `updated_at`), затем из `booking.seedSeries[]`.
- **Консультации**: `kind = 'individual'`, `event_id NULL`, `resource_id` — консультант или `NULL` («серая»).
  Все функции статусов (§6.3) не зависят от `kind`, кроме блокировки места: у группы — строка `events`, у
  консультации — B5 (advisory lock по `resource_id + booking_date`). Маршрут B2 принимает только
  `kind: 'group'` (Zod); `createBooking` с `kind: 'individual'` до B3a бросает обычную `Error('B3a')` (500,
  ошибка сборки, а не ответ пользователю).

## 3. Права и охваты (D-136)

| Действие | Обёртка | Проверка в домене | Кто у первого клиента |
|---|---|---|---|
| список и карточка мероприятия, места | `booking.read` | `scopeSql(v,'event','booking.read')` | все роли с записью; дежурный — своё сегодня |
| мастер: ближайшие мероприятия клиента | `booking.create` | `scopeOf(v,'booking.create') !== null` **и** карточка клиента видна `scopeSql(v,'card','booking.create')` | оператор — свои клиенты; РОП — все |
| создать / перенести / подтвердить / снять подтверждение / отменить групповую запись | `booking.create` | то же: роль, а не отношение (консультант по `booked_with_me` групповые записи не трогает); строка записи — `scopeSql(v,'booking','booking.create')` | оператор — свои; РОП — все |
| «Пришёл», «Не пришёл» | `booking.attend` | `scopeSql(v,'booking','booking.attend')` (дежурный — запись своего мероприятия сегодня) | РОП; дежурный (оператор или консультант с `duty_today`); оператор без дежурства — нет (PROCESS 8.2) |
| «Пришёл → Не пришёл» после суток мероприятия | `booking.attend` | `lateCorrection = scopeOf(v,'booking.manage') !== null` | только РОП |
| список гостей мероприятия | `booking.read` | строки — `scopeSql(v,'booking','booking.read')`; имя клиента, контакт, хвост номера — проекция без охвата клиента (D-072) | дежурный — все гости своего мероприятия сегодня; оператор — только свои; РОП — все |
| серии, разовое мероприятие, правка, отмена мероприятия, дежурные | `booking.manage` | `scopeSql(v,'event','booking.manage')` на строке; серия — `space_id = v.spaceId` и `scopeOf(v,'booking.manage')` | РОП |

Чужая запись, чужой клиент, мероприятие чужого пространства — `NotFoundError` (тот же байт-в-байт ответ,
что у несуществующего id). Директор (`readOnly`) — 423 на любую мутацию (обёртка). Места («осталось 12 из 30»)
считаются по всем записям мероприятия без охвата записей: это число, не данные клиента (D-136).

## 4. API (route handlers через `route()`; тела — Zod; ответы — JSON без ПДн, кроме гостей)

| Метод и путь | Право / цель | Тело или запрос | Ответ |
|---|---|---|---|
| `GET /api/events` | `booking.read` / section | `?from=YYYY-MM-DD&to=…&type=&cancelled=0\|1` (окно ≤ 62 дня) | `EventView[]` |
| `POST /api/events` | `booking.manage` / section | `EventInput` | `EventView` (повтор — то же) |
| `GET /api/events/offer` | `booking.create` / section | `?clientId=&type=` | `OfferResult` |
| `GET /api/events/[id]` | `booking.read` / object `event` | — | `EventView` |
| `PATCH /api/events/[id]` | `booking.manage` / object `event` | `{ seenUpdatedAt, patch: EventPatch }` | `EventView` |
| `POST /api/events/[id]/cancel` | `booking.manage` / object `event` | `{ opId }` | `CancelEventResult` |
| `PUT /api/events/[id]/duty` | `booking.manage` / object `event` | `{ userIds: string[] }` (≤ 10) | `{ userIds }` |
| `GET /api/events/[id]/guests` | `booking.read` / object `event` | — | `GuestRow[]` |
| `GET /api/events/series` | `booking.manage` / section | — | `SeriesView[]` |
| `POST /api/events/series` | `booking.manage` / section | `SeriesInput & { requestId }` | `{ series, sync }` |
| `PATCH /api/events/series/[id]` | `booking.manage` / section | `{ seenUpdatedAt, patch }` | `{ series, sync }` |
| `GET /api/bookings` | `booking.read` / section | `?from&to&status=a,b&eventId&clientId` (≤ 200 строк) | `BookingView[]` |
| `POST /api/bookings` | `booking.create` / section | `GroupBookingRequest` | `CreateBookingResult` (201 / 200 при `replayed`) |
| `GET /api/bookings/[id]` | `booking.read` / object `booking` | — | `BookingView` |
| `POST /api/bookings/[id]/confirm` | `booking.create` / object `booking` | `{ opId, version, to: 'confirmed'\|'registered' }` | `BookingView` |
| `POST /api/bookings/[id]/cancel` | `booking.create` / object `booking` | `{ opId, version, reason: 'client'\|'operator_error' }` | `BookingView` |
| `POST /api/bookings/[id]/move` | `booking.create` / object `booking` | `{ requestId, version, eventId }` | `CreateBookingResult` |
| `POST /api/bookings/[id]/attendance` | `booking.attend` / object `booking` | `{ opId, version, to: 'attended'\|'no_show' }` | `BookingView` |

`opId`, `requestId` — UUID с устройства (Zod `uuid()`). Next 16: `params` — `Promise` (читает обёртка);
перед кодом — `node_modules/next/dist/docs/` (route handlers). «Отменил, просил не звонить» — не этот API:
интерфейс вызывает итог «Полный отказ» (calling), а ядро выпускает `cancel_future: do_not_call` (§7.2).
`cancelled → registered` («передумал») API не открывает: это новая запись через мастер (D-133).

## 5. Транзакции, блокировки, SQL

**Порядок блокировок (D-131): карточка(и) по возрастанию `id` → мероприятие → записи.** Уровень —
READ COMMITTED (по умолчанию). Повтор `40P01`/`40001` — только во внешней транзакции (`tx.ts`), не внутри
чужой (`opts.tx`). Все запросы с данными — `scoped(sql)` + `scopeSql`.

### 5.1. Создать групповую запись (`createBooking`, `kind = 'group'`)

```sql
-- 1. карточка = блокировка клиента в пространстве (12.18); не видна → 404
SELECT c.id, c.client_id, c.space_id, c.state, c.owner_user_id, c.acting_user_id, c.last_outcome_at, c.version
FROM cards c WHERE c.space_id = ${v.spaceId} AND c.client_id = ${clientId}
  AND ${scopeSql(v,'card','booking.create')} FOR UPDATE OF c;
-- fromOutcome: шаг 1 уже сделал C5 в своей транзакции — repo только читает строку без FOR UPDATE.
-- 2. повтор ключа (после блокировки — параллельный дубль увидит первую вставку)
SELECT … FROM bookings b WHERE b.request_id = ${requestId};
--    есть: тот же client_id и event_id (или moved_from цепочка) → прежний результат, replayed = true;
--          иначе → request_reused (409).
-- 3. состояние карточки: не fromOutcome и state ∉ ('agreed','client') → outcome_required (409).
-- 4. контакт: contactId ≠ NULL → SELECT 1 FROM contacts WHERE id = $ AND client_id = ${clientId} AND archived_at IS NULL, иначе 400.
-- 5. мероприятие
SELECT e.* FROM events e WHERE e.id = ${eventId} AND ${scopeSql(v,'event','booking.read')} FOR UPDATE OF e;
--    нет → event_not_found (404); вид не групповой в настройках → invalid_settings (409).
-- 6. занято — НОВЫЙ оператор после блокировки (видит всё зафиксированное до нас)
SELECT count(*)::int AS taken FROM bookings b
WHERE b.event_id = ${eventId} AND b.status IN ('registered','confirmed','attended','no_show');
--    booking.eventBookability(event, taken, now): event_cancelled | event_in_past | event_full
--    event_full → alternatives = booking.offerEvents(ближайшие по виду, now, groupOptions) (§5.6).
-- 7. записи клиента для решения «новая или перенос»
SELECT b.id, b.status, b.event_type_key, b.event_id, b.starts_at, b.booked_by_user_id FROM bookings b
WHERE b.space_id = ${spaceId} AND b.client_id = ${clientId}
  AND b.status IN ('registered','confirmed','attended','no_show') FOR UPDATE OF b;
--    booking.resolveRepeatBooking(existing, {eventTypeKey, eventId}, now):
--    reject → already_registered (409); move → §5.2 с bookedBy исходной; create → дальше.
-- 8. сделка: dealId = deps.deals.ensureOpen(tx, actor, card, { requestId, at: now, stages })
-- 9. вставка
INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, deal_id, contact_id,
  booking_date, start_time, starts_at, duration_min, status, via, booked_by_user_id, responsible_user_id,
  request_id, import_key, version, created_at, updated_at)
VALUES (…, 'group', …, 'registered', ${via}, ${bookedBy}, ${card.ownerUserId}, ${requestId}, ${importKey}, 0, ${now}, ${now})
ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING RETURNING id;
--    23505 по bookings_group_uq (не должно случиться под блокировками) → already_registered.
-- 10. booking_history (action 'created', to_status 'registered', actor_id, meta {requestId, via})
--     и client_events (kind 'booking.created', ref_type 'booking', data {bookingId, eventId, eventTypeKey, eventDate, via}).
```

`ClientBookingLite.bookedByUserId` в ядре — `string`; `NULL` из БД передаётся как `''` и при переносе
пишется обратно `NULL` (или T0-правка ядра на `string | null`, §13).

### 5.2. Перенос (`moveBooking` и ветка `move` из 5.1)

Под теми же блокировками (карточка → новое мероприятие → записи клиента): старая запись — `FOR UPDATE`,
`version` совпадает (иначе `throwNotFoundOrConflict`), статус ∈ `registered | confirmed | no_show`
(`booking.checkTransition(from, 'moved')`). Карточка не в `agreed`/`client` → `outcome_required` (перенос
«не пришедшего» после № 16 идёт через итог). Цель: место по 5.1 шаги 5–6; та же цель, что у старой, →
`already_registered`. Вставка новой: `booked_by_user_id` и `deal_id` — **из старой**, `moved_from_id` = старая,
`responsible_user_id` = текущий владелец карточки. Затем

```sql
UPDATE bookings b SET status = 'moved', moved_to_id = ${newId}, version = b.version + 1, updated_at = ${now}
WHERE b.id = ${oldId} AND b.version = ${version} AND ${scopeSql(v,'booking','booking.create')};
```

История: старой — `('moved', from, 'moved', meta {toId})`, новой — `('created', '', 'registered', meta {fromId})`;
лента — одно событие `booking.moved` `{fromId, toId, fromEventId, toEventId}`. Событие карточки не нужно:
у карточки остаётся активная будущая запись. Старое мероприятие не блокируется: освобождённое место
другие увидят после фиксации.

### 5.3. Статусы (`setConfirmation`, `markAttendance`, `cancelBooking`)

Общий шаг: прочитать запись `scopeSql(v,'booking', perm)` без блокировки → узнать `card_id` → блокировать
карточку (`FOR UPDATE`, без охвата карточки: охват уже проверен на записи; дежурному карточка не видна, D-072)
→ блокировать запись `FOR UPDATE` с тем же охватом. Затем:

1. `SELECT 1 FROM booking_history WHERE id = ${opId}` → есть: повтор, вернуть текущую `BookingView`.
2. `version` ≠ → 409 `conflict` (`throwNotFoundOrConflict`).
3. `booking.checkTransition(from, to, { tz, now, startsAt, durationMin, lateCorrection })` → `too_early`,
   `too_late`, `invalid_transition`, `same_status` (409).
4. Отмена `operator_error`: только `booked_by_user_id = v.userId` и `now − created_at ≤ 10 мин` (12.7),
   иначе `too_late`.
5. `UPDATE bookings SET status, cancel_reason, version+1, updated_at WHERE id AND version AND scope`.
6. `booking_history` с `id = opId` (action `status` / `cancelled`), лента `booking.status` `{bookingId, from, to, reason}`.
7. Событие карточки (§7.1). `hasOtherFutureBooking`/`hasNextFutureBooking` считаются **после** шага 5:
   `EXISTS (SELECT 1 FROM bookings WHERE space_id AND client_id AND id <> ${id} AND status IN
   ('registered','confirmed') AND starts_at > ${now})`.

`confirmed ↔ registered` событий карточки не порождает.

### 5.4. Отмена мероприятия каскадом (`cancelEvent`, 12.26)

```sql
-- 1. кого затронем (без блокировок)
SELECT DISTINCT b.card_id FROM bookings b WHERE b.event_id = ${eventId} AND b.status IN ('registered','confirmed');
-- 2. карточки по возрастанию id: SELECT … FROM cards WHERE id = ANY(${ids}) ORDER BY id FOR UPDATE
-- 3. мероприятие FOR UPDATE со scopeSql(v,'event','booking.manage'); уже cancelled → replayed (идемпотентно по состоянию);
--    началось → event_in_past.
-- 4. UPDATE events SET status = 'cancelled', touched = TRUE, updated_at WHERE id
-- 5. активные записи FOR UPDATE; если появилась запись карточки не из шага 1 (вставлена между 1 и 3) —
--    заблокировать и её карточку (возможна взаимная блокировка → 40P01 → повтор всей транзакции).
-- 6. UPDATE bookings SET status='cancelled', cancel_reason='event_cancelled', version+1 WHERE id = ANY(...)
-- 7. история (action 'event_cancelled', meta {opId, eventId}), лента booking.status на каждую запись
-- 8. по каждой карточке в состоянии agreed: CardPort booking_cancelled (§7.1) с hasOtherFutureBooking
-- 9. audit_log 'event.cancel' {eventId, count} — в той же транзакции
```

Напоминания по отменённым не показываются сами (фильтр по статусу, B3b).

### 5.5. Серии и мероприятия

- `syncSeries`: `SELECT … FROM event_series WHERE id FOR UPDATE` (сериализует с job); мероприятия серии
  на горизонте `FOR UPDATE` (кроме снятых); после блокировки — **новым оператором** число записей в
  статусах, держащих место, и дежурных → `booking.ExistingEvent`; `booking.planSeriesSync(series, existing,
  { tz, now, horizonDays, isWorkday: calendar.isWorkday })`; применить: `INSERT … ON CONFLICT (occurrence_key)
  WHERE occurrence_key IS NOT NULL DO NOTHING`; `UPDATE` изменённых; `remove` → «снять» (`status='cancelled',
  occurrence_key=NULL, updated_at`). Нет `DELETE`: у `crm_app` его на `events` нет (D-135).
- Неактивная серия (`active = false`) → `seriesOccurrences` пуст → все нетронутые будущие сняты.
- Создание серии: `id = requestId`, `ON CONFLICT (id) DO NOTHING`; прочитанная строка другого содержания →
  `request_reused`. Затем `syncSeries` в той же транзакции.
- Разовое мероприятие: вид — групповой из настроек, `id = requestId`, умолчания §2, `touched = FALSE`.
- Правка мероприятия: `UPDATE … WHERE id AND updated_at = ${seenUpdatedAt} AND scope`, `touched = TRUE`.
  `capacity` < занято → `capacity_below_taken`; дата или время при `taken > 0` → `event_has_bookings`
  (D-137); дата и время пересчитывают `starts_at` через `booking.localToEpoch(tz, …)`.
- Дежурные: `DELETE FROM event_duty WHERE event_id` + `INSERT` (DELETE разрешён). Сотрудники — с активным
  членством в пространстве (`memberships`, `users.status = 'active'`), иначе 400. Дежурных по умолчанию не
  создаём: РОП отмечает явку своим охватом.

### 5.6. Мастер: ближайшие мероприятия (`offerEvents`)

Карточка клиента видна по `booking.create` (иначе 404) → мероприятия пространства `scheduled`, `starts_at >
now`, дата ≤ сегодня + `horizonDays`, с `taken` подзапросом (§2), → `booking.offerEvents(…, groupOptions,
type)`; `current` — активная будущая запись клиента того же вида (UI пишет «перенос с …»). Тот же запрос
даёт `alternatives` для `event_full`.

## 6. Идемпотентность (D-132)

| Действие | Ключ | Повтор |
|---|---|---|
| создать, перенести | `bookings.request_id` = `requestId` | после блокировки карточки: тот же клиент и мероприятие → прежний результат, `replayed: true` (200); другое → 409 `request_reused` |
| подтвердить, отменить, явка | `booking_history.id` = `opId` | строка есть → текущая запись (200), без повторных эффектов |
| отменить мероприятие | состояние | уже `cancelled` → `replayed: true`, без эффектов |
| серия, разовое мероприятие | `id` = `requestId` | `ON CONFLICT (id) DO NOTHING` → прежняя строка |
| синхронизация серии | `events.occurrence_key` | повторный прогон ничего не создаёт |

## 7. Связь с карточкой обзвона и сделкой

### 7.1. События карточки (через `CardPort`, реализует calling в C5)

| Действие записи | Состояние карточки | Событие ядра `calling` | Факты |
|---|---|---|---|
| «Не пришёл» (ручное) | `agreed` | `no_show { bookingId }` | `hasOtherFutureBooking` |
| «Пришёл» | `agreed` | `attended { bookingId, eventDay }` | `hasNextFutureBooking` |
| «Пришёл» | `client` и др. | — ; домен сам `deals.advanceOnAttended` (только вперёд) | — |
| исправление «Не пришёл → Пришёл» | `callback` | `attendance_corrected { bookingId, noShowMarkedAt }` (время последней строки истории `to_status='no_show'`) | `hasNextFutureBooking` |
| исправление «Не пришёл → Пришёл» | `agreed` | `attended` (как № 18) | `hasNextFutureBooking` |
| «Пришёл → Не пришёл» | `agreed` | `no_show` (№ 16 как обычно) | `hasOtherFutureBooking` |
| отмена `client` / `operator_error` | `agreed` | `booking_cancelled { reason, createdByOpId: booking.request_id }` | `hasOtherFutureBooking` |
| отмена мероприятия | `agreed` | `booking_cancelled { reason: 'client' }`; в БД `cancel_reason = 'event_cancelled'` | `hasOtherFutureBooking` |
| автонеявка (B4b) | `agreed` | `attendance_sweep { markerUserId }` | `workdaysElapsed`, `hasOtherFutureBooking` |

Событие вызывается, только если состояние совпадает со столбцом; иначе запись меняется без карточки.
`opId` события — `opId` действия; в каскаде один `opId` на все карточки (ключи задач ядро строит по
`bookingId`). Ответ `rejected` (`stale`, `invalid_transition`) не откатывает действие с
записью: пишется `booking_history.meta.card = код`, запись остаётся в новом статусе. Исключение —
`forbidden`/`not_found` от порта: это ошибка сборки → откат (500).

Контракт C5 (`src/server/domain/cards/bookingPort.ts`): снимок карточки по `LockedCard.id` без повторной
блокировки → `calling.applyOutcome({ card, event, actor: { userId, kind, scope }, now, settings, calendar })`
→ запись карточки (`version`), `tasks/auto.ts`, лента, уведомления, `deals/effects.applyDealEffects`,
`booking/effects.applyBookingEffects`. `scope` актёра: `scopeOf(v,'card.outcome') ?? 'relation'`; система —
`kind: 'system'`.

Итог «Договорились» (C5, PROCESS 12.7 — одна транзакция «итог + запись + сделка»): C5 блокирует карточку →
`createBooking(deps, viewer, { kind: 'group', requestId: opId, … }, { tx, fromOutcome: { opId } })` →
`applyOutcome` с `agreement.bookingId` → эффект `ensure_open` находит ту же сделку (по `request_id = opId`
или открытой в воронке). Отклонённый итог откатывает всё.

### 7.2. Эффекты записей для исполнителя (`booking/effects.ts`)

- `cancel_future { reason }`: активные записи клиента в пространстве с `starts_at > at` → `cancelled`,
  `cancel_reason = reason` (`do_not_call`; `not_target` — после миграции M1), история, лента. **Без** событий
  карточки (их уже применяет вызывающий переход).
- `reassign_future { to }`: у тех же записей `responsible_user_id = to`; `booked_by_user_id` не трогается.

### 7.3. Сделки (`deals/effects.ts`, минимум B2; остальное — B6)

- `ensureOpen`: открытая сделка клиента (`card_id`, `pipeline_key`, `status = 'open'`) или `INSERT` на этапе
  `onAgreedStageKey` с `request_id`, `owner_user_id = card.ownerUserId`, `created_by = actor`; лента `deal.created`.
  `stages = null` → `null`. Гонка невозможна: обе ветки под блокировкой карточки.
- `advanceOnAttended`: этап `onAttendedStageKey`, если его `order` больше текущего (только вперёд); лента `deal.stage`.
- `applyDealEffects` для C5: `ensure_open`, `advance`, `set_needs_rebook` (по `bookings.deal_id`),
  `lose_created_by` (сделка с `request_id = opId`, `status → lost`, `lost_reason_code = 'input_error'`).
  Остальные операции (`lose_open`, `lose`, `win`, `cancel_purchase`, `reassign_open`) — бросают
  «B6/B9a» до своих задач; вызывающий их пока не порождает в путях B2.

## 8. Автонеявка, гость без записи, консультации

- B4b: `SweepAttendance` (тип есть). Выбор кандидатов — `booking.autoNoShowDue`; событие —
  `attendance_sweep`; статус `no_show` пишет домен записи только при `workdaysElapsed ≥ limit`.
- B4: гость без записи — `via = 'walk_in'`, статус сразу `attended`, заслуга — владелец клиента, проверка
  номера — общий счётчик D-040. Использует `createBooking` с `imported`-подобной опцией (добавит architect B4).
- B3a/B5: `IndividualBookingRequest`; блокировка места консультанта — advisory lock `resource_id +
  booking_date` (ключ в `platform/db/locks.ts` через platform).

## 9. Лента и история

`booking_history.action`: `created`, `moved`, `status`, `cancelled`, `event_cancelled`;
`meta` — только id и коды (`opId`, `requestId`, `eventId`, `toId`, `fromId`, `reason`, `card`).
`client_events.kind`: `booking.created`, `booking.moved`, `booking.status`; `ref_type = 'booking'`.
Дата и время мероприятия — в `data` как коды (`eventDate`, `startTime`), имён нет.

## 10. Ошибки и HTTP

| Код | HTTP | Ответ |
|---|---|---|
| `booking_not_found`, `event_not_found`, `series_not_found`, `consultant_not_found` | 404 | `throw new NotFoundError()` — тело как у несуществующего |
| `event_full` | 409 | `{ error: 'conflict', detail: 'event_full', alternatives: EventOption[] }` (маршрут сам строит `Response`) |
| `event_cancelled`, `event_in_past`, `already_registered`, `invalid_transition`, `same_status`, `too_early`, `too_late`, `outcome_required`, `request_reused`, `event_has_bookings`, `capacity_below_taken`, `invalid_settings` | 409 | `{ error: 'conflict', detail: <код> }` |
| устаревшая `version` / `seenUpdatedAt` | 409 | `ConflictError` (`{ error: 'conflict' }`) |
| `move_target_required`, плохое тело | 400 | `BadRequestError(<код>)` / ZodError |
| `card_port_unavailable` | 503 | `{ error: 'internal', detail: 'card_port_unavailable' }` — только до C5 |

Оператору чужое не раскрывается: «уже записан» показывается только для своего клиента (охват карточки
проверен на шаге 1).

## 11. Тесты

Синтетика: номера `+7 709 …`, имена выдуманные. Интеграционные — Postgres 16, временная схема
(`createTestDb`), часы — `now` в `deps`. Порт карточки в тестах — `tests/integration/booking/fakeCardPort.ts`:
строит `CardSnapshot` из строки карточки, зовёт настоящий `calling.applyOutcome`, **записывает** событие и
результат в массив (без записи в БД). Проверяется вход порта, а не эффекты C5.

`tests/integration/booking/`:
- `create.test.ts` — запись на `agreed`: строка, история, лента, `deal_id` (воронка `createDealOn: agreed`),
  `responsible = owner`, `booked_by = viewer`; повтор того же `requestId` → `replayed`, одна строка; тот же
  ключ на другое мероприятие → `request_reused`; карточка `callback` → `outcome_required`; `fromOutcome` —
  проходит из `callback`; прошедшее/отменённое → коды; контакт чужого клиента → 400; консультант по
  отношению → 404.
- `race.test.ts` — **гонка за последнее место**: вместимость 30, занято 29; два оператора, разные клиенты,
  `Promise.all` на двух соединениях → ровно одна `created`, вторая `event_full` с `alternatives` (следующие
  мероприятия с местами), `taken = 30`. Повторить 20 раз. Вариант «вместимость 5, 12 параллельных» → ровно
  5. Один клиент, два разных `requestId` параллельно → одна запись, вторая `already_registered`. Один
  `requestId` параллельно → одна строка, второй ответ `replayed`.
- `move.test.ts` — **перенос**: активная будущая на E1, запись на E2 → `action: 'moved'`, старая `moved` +
  `moved_to_id`, новая `moved_from_id`, `booked_by` исходного оператора, хотя переносит РОП; `deal_id` тот же;
  места E1 −1, E2 +1; `/move` на полное → `event_full`, ничего не изменилось; на то же → `already_registered`;
  устаревшая `version` → 409; `no_show` при карточке `callback` → `outcome_required`.
- `cancel.test.ts` — отмена `client`: место освобождено, порт получил `booking_cancelled` с
  `hasOtherFutureBooking`; `operator_error` автором ≤ 10 мин — да, через 11 мин — `too_late`, не автором —
  `too_late`; повтор `opId` → 200 без второго события порта; `cancelled → registered` недоступен.
- `event-cancel.test.ts` — **отмена каскадом**: 18 записей (registered/confirmed), одна уже `cancelled` →
  17 стали `cancelled/event_cancelled`, история и лента у каждой, порт вызван по каждой карточке `agreed`
  (у клиента с другой будущей записью — факт `true`), мероприятие `cancelled`; повтор → `replayed`, 0
  изменений; запись на него → `event_cancelled`; мастер его не предлагает; синхронизация серии его не
  возвращает; параллельно с отменой запись на то же мероприятие — либо до (и отменена каскадом), либо
  `event_cancelled`.
- `attendance.test.ts` — `attended` до суток мероприятия → `too_early`; `no_show` до начала → `too_early`;
  дежурный в день мероприятия отмечает, на следующий день — 404; оператор без дежурства — 404 (`booking.attend`
  нет); исправление `no_show → attended` → порт `attendance_corrected` с `noShowMarkedAt`; при `agreed` —
  `attended`; `attended → no_show` дежурным в тот же день — да, РОП через 2 дня — да (`lateCorrection`),
  карточка `client` → сделка сдвинута напрямую.
- `series.test.ts` — серия «чт 15:00» на 28 дней по календарю с праздником в четверг → 3 мероприятия и 1
  пропуск; повтор синхронизации → 0 изменений; смена времени → нетронутые обновлены, с записью/дежурным/
  `touched` — нет; смена дня недели → старые нетронутые сняты (`occurrence_key NULL`), возврат дня → созданы
  снова; `active = false` → нетронутые будущие сняты; `id = requestId` повтор → одна серия.
- `events.test.ts` — разовое мероприятие (умолчания места и формата), повтор `requestId`; `capacity` ниже
  занятого → `capacity_below_taken`; дата при записях → `event_has_bookings`; устаревший `seenUpdatedAt` →
  409; дежурные; гости: в JSON нет полного номера (только 4 цифры), нет `custom`.
- `effects.test.ts` — `cancel_future do_not_call` отменяет только будущие активные, прошедшие не трогает;
  `reassign_future` меняет `responsible`, не `booked_by`.
- `isolation.test.ts` — оператор B: `GET/confirm/cancel/move/attendance` записи оператора A → 404 байт в
  байт как несуществующий id, строки не изменились; `GET /api/bookings` и `offer` без чужого; `POST
  /api/bookings` с `clientId` A → 404; дежурный видит всех гостей своего мероприятия сегодня и не видит
  карточку клиента; директор → 423 на мутации.

`tests/integration/deals/effects.test.ts` — `ensureOpen` идемпотентен; воронка `manual` → `null`; `advance`
только вперёд; `lose_created_by`.

`tests/unit/booking/` — `settings.test.ts` (разбор пресетов base и consulting-sales + накладки клиента,
`deals = null` при `createDealOn: manual`), `errors.test.ts` (код → HTTP и тело §10).

`tests/isolation/manifest/booking.ts` — все 18 входов §4 (`idParam` `event`/`booking` у объектных,
`touches`: `bookings`, `booking_history`, `events`, `event_series`, `event_duty`, `deals`, `client_events`,
`audit_log`).

## 12. Нужно от других

| Что | Кому | Срок |
|---|---|---|
| **M1** миграция `migrations/2026-10-22-booking-fix-cancel-reason.sql`: `ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancel_reason_check; ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_reason_check CHECK (cancel_reason IN ('','client','event_cancelled','operator_error','do_not_call','not_target'));` — ядро `calling` выпускает `cancel_future: not_target`, схема его не принимает (D-137) | координатор (оформить), architect (дизайн здесь) | до C5 |
| `src/server/platform/audit.ts`: `AuditEntity` + `'event' \| 'series'`; действия `event.create`, `event.update`, `event.cancel`, `event.duty`, `series.create`, `series.update` | platform (или разрешить builder B2 эти строки) | с B2 |
| `src/server/domain/cards/bookingPort.ts` по контракту §7.1, `tasks/auto.ts` для эффектов задач; замена `cards` в `booking/deps.ts` | calling (C5) + координатор | 23.10 |
| регистрация job `events-ensure` (ежедневно 03:00 и после `config apply`) → `ensureAllSeries` | platform (P7) | 23.10 |
| **M2** (B3b, не сейчас): `tasks_source_check` + `event_moved` для «Сообщить о переносе» | architect B3b | 24.10 |

## 13. Разбивка работ

| № | Задача | Уровень | Кто |
|---|---|---|---|
| 1 | `errors.ts`, `tx.ts`, `cardPort.ts`, `deps.ts`, `index.ts`, `messages/ru/booking.json` | T0 | mechanic |
| 2 | ядро: `ClientBookingLite.bookedByUserId: string \| null`; `CANCEL_REASONS` + `not_target` (после M1) | T0 | mechanic |
| 3 | `settings.ts` + unit-тест | T1 | builder |
| 4 | `repo.ts` + `series.ts` + `events.ts` (§5.4–5.6) + тесты `series`, `events` | T1 | builder |
| 5 | `bookings.ts` (§5.1–5.3), `effects.ts`, `deals/{repo,effects}.ts` + тесты `create`, `race`, `move`, `cancel`, `event-cancel`, `attendance`, `effects`, `deals/effects` | T1 (по этому дизайну, T2→T1) | builder |
| 6 | маршруты §4, `_lib.ts`, манифест, `isolation.test.ts` | T1 | builder |
| 7 | ревью блокировок, охватов и идемпотентности перед влитием | T2 | reviewer |
