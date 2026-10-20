# Раздача: пул, автотик, ручная выдача, журнал — дизайн C6a для builder

Статус: дизайн architect, 22.10.2026. Нормативно: PROCESS §7, §12.11–12.12, §12.23–12.24; CONFIG §6.6–6.7;
D-038, D-039, D-145; решения **D-173, D-174**. Контракт — `src/server/domain/distribution/types.ts` (готов).
Ядро — только корень: `import { distribution, calling, time } from '@crm/core'`. Next 16: перед маршрутами
прочитай `node_modules/next/dist/docs/` (route handlers). Все примеры — синтетика.

## 1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/distribution/types.ts` | контракт (готов) |
| `settings.ts` | `loadDistributionConfig`: `distribution.*`, `queue.mobileFirst`, календарь (`time.createWorkCalendar` → `distribution.toDistributionCalendar`); Zod-срез как в `booking/settings.ts`; ошибка → `invalid_settings` |
| `repo.ts` | весь SQL (§5) |
| `participants.ts` | участники и статусы: `listParticipants`, `setParticipation`, `loadParticipantsForPlan` |
| `pool.ts` | `getPool`, `loadCandidates` (кандидаты + двойники + heldBy + blocked, §4) |
| `assign.ts` | чистая `assignRows(...)`: строки карточки, журнала, ленты и уведомлений для выдачи — семантика ядра `assign` |
| `tick.ts` | `runTick` (§3.1) |
| `manual.ts` | `issueCards` (§3.2) |
| `journal.ts` | `getJournal` |
| `errors.ts` | `DistributionDomainError(code, extra)` + HTTP-отображение |
| `job.ts` | `distributeJob: JobDefinition` (контракт `src/server/platform/jobs/types.ts`) |
| `deps.ts`, `index.ts` | зависимости (настройки, часы; подмена только в тестах) и экспорты |
| `src/app/api/distribution/**` | маршруты §6 через `route()` |
| `src/server/platform/audit.ts` | + сущность `distribution`, действия `distribution.issue`, `distribution.participant` (строки модуля, как разрешает шапка файла) |
| `messages/ru/distribution.json` + `NAMESPACES` в `src/i18n/config.ts` | тексты ошибок и подписей |
| `tests/isolation/manifest/distribution.ts` | все маршруты §6 |

Интерфейс РОП (`src/app/(mgr)/distribution/**`) — отдельная задача T1 после API (§10).

## 2. Модель

- **Пул** — `cards`: `space_id`, `owner_user_id IS NULL`, `state = 'new'`, `hold_reason = ''` (индекс
  `cards_pool_idx`). Порядок — `created_at, id`; мобильные раньше городских по `queue.mobileFirst`.
- **Участник** — активное членство с ролью из `distribution.participantRoles`, активный сотрудник.
  Статус: `absent` — есть `absences` (не отменённое) на сегодня; `paused` — `memberships.paused_on = сегодня`;
  иначе `working`. Тик выдаёт только `working` и `in_distribution = TRUE`; ручная выдача — любому `working`
  участнику (флаг участия не нужен). «Пауза» и «Отсутствует» пишет C6b; здесь только чтение.
- **Открытые** (`open`) — у сотрудника (`COALESCE(acting_user_id, owner_user_id)`): `new` + `retry`/`callback`
  со сроком `next_call_at ≤ now`, без задержки. `openNew` — только `new`.
- **Выдано сегодня** (`issuedToday`) — `assign_log` за местные сутки по видам (`auto`, `manual`, `return`,
  `inbound`, `proposal`); лимит считает ядро `capRemaining` по `capIncludes` (D-039). «Вернуть в пул» лимит
  не восстанавливает: строка выдачи остаётся.
- **Журнал** — каждая выдача = строка `assign_log` (`run_id` = `job_runs.id` тика или `opId` ручной выдачи).

## 3. Транзакции

Всё, что меняет пул или расход лимита, — одна транзакция под `pg_advisory_xact_lock(DISTRIBUTION_LOCK_KEY)`
(тик, ручная выдача; дальше C6b «вернуть в пул»/«Отсутствует», C6c возвраты). Внутри транзакции первой
командой — `SET LOCAL lock_timeout = '10s'`. Карточки берутся `FOR UPDATE SKIP LOCKED` (не ждём итог,
импорт и приём), порядок блокировок: advisory → карточки по `id`. Итоги (C5) этот ключ не берут: они не
меняют пул и лимит. Взаимной блокировки нет: тик ничего не ждёт, кроме своего advisory.

### 3.1. Тик (`runTick`, job `distribute@<space>`)

```
cfg = config(spaceId, now)
early = distribution.planDistribution({ now: slotAt, calendar, settings, participants: [], pool: [] })
если early.status = 'skipped' → { skipped, reason }               -- режим manual/off, ночь, выходной
tx:
  SET LOCAL lock_timeout = '10s'; pg_advisory_xact_lock(DISTRIBUTION_LOCK_KEY)
  если repo.runApplied(spaceId, day, runId) → { skipped, 'already_applied' }   -- повтор слота после сбоя
  [C6c, неделя 2: возвраты «Не интересует» — до пула, PROCESS 12.23; здесь returned = 0]
  participants = loadParticipantsForPlan(...)  -- только in_distribution
  нет working → 'no_participants'; Σ room = 0 → 'no_room'
  candidates = loadCandidates(spaceId, limit = Σroom·2 + 50)  -- + недостающие двойники, §4
  пусто → 'empty_pool'
  plan = distribution.planDistribution({ now: slotAt, …, participants, pool: candidates, mobileFirst })
  written = repo.writeAssignBatch(tx, actor, { kind: 'auto', runId, byOperator: plan.byOperator,
                                                countsToCap: capIncludes ∋ 'auto', day, actorId: null, now })
  → TickReport { issued, assigned, heldBack, blocked, overCap, raced }
```

`slotAt` — начало слота (`ctx.slot.at`): окно проверяется по нему, поэтому тик 18:00, начатый в 18:00:40,
не теряется. Пропущенный тик не догоняется (`graceMin` 15, D-171). `day` — местные сутки `now`.

**Идемпотентность тика:** один прогон на слот (`job_runs`), повтор упавшего прогона — с тем же `runId`.
Транзакция откатилась — повторять нечего; транзакция закоммитилась, а воркер упал до отметки `ok` — проверка
`runApplied` (`SELECT EXISTS … FROM assign_log WHERE space_id = $s AND day = $day AND run_id = $runId`,
индекс `assign_day_idx`) не даст выдать второй раз; уведомления — `dedupe_key = assign:<runId>:<user>`.

### 3.2. Ручная выдача (`issueCards`, «Раздать выбранные»)

```
tx: lock_timeout; advisory
  повтор: строки assign_log с run_id = opId (day ∈ {сегодня, вчера}) → прежний итог, replayed = true
  cfg.settings.mode = 'off' → mode_off
  p = участник toUserId (роль из participantRoles, активен) иначе not_participant
  candidates:
    cardIds → эти карточки, если в пуле (scopeSql(viewer, 'card', 'card.assign')), + их двойники из пула;
              не в пуле → skipped not_in_pool
    count   → первые count готовых карточек пула (как в тике)
  settingsForPlan = capOverride или capIncludes ∌ 'manual' → dailyCap = MAX_SAFE_INTEGER, иначе как есть
  plan = distribution.planAllocation([p], candidates, settingsForPlan, { mobileFirst: false })
  plan.overCap не пуст → over_cap { remaining, cap } — НИЧЕГО не выдаём (PROCESS 7.3: «раздадим завтра»)
  статус p ≠ working → not_working (distribution.checkManualIssue)
  heldBack → skipped pair_held; blocked → skipped pair_blocked
  written = writeAssignBatch({ kind: 'manual', runId: opId, actorId: viewer.userId, countsToCap: capIncludes ∋ 'manual' })
  writeAudit(distribution.issue, entityId = toUserId, meta { count, skipped })
```

### 3.3. Запись выдачи (`writeAssignBatch`, repo.ts)

1. `SELECT c.id FROM cards c WHERE c.id = ANY($ids) AND c.space_id = $s AND c.owner_user_id IS NULL AND
   c.state = 'new' AND c.hold_reason = '' ORDER BY c.id FOR UPDATE OF c SKIP LOCKED` → множество L.
2. Группа двойников целиком или никак: карточка, у которой хоть один двойник из плана не в L, выпадает в
   `raced` вместе со всей группой (повторить, пока множество не перестанет меняться). Пару не делим (D-038).
3. `UPDATE cards c SET owner_user_id = w.owner, assigned_at = $now, version = c.version + 1, updated_at = $now
   FROM unnest($ids::text[], $owners::text[]) AS w(id, owner) WHERE c.id = w.id RETURNING c.id, c.client_id`.
   `touched_in_crm` не трогаем (D-145).
4. `INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day,
   actor_id, created_at) SELECT … FROM unnest(…)` — `from_user_id = NULL`.
5. `INSERT INTO client_events (…) SELECT … FROM unnest(…)`: `kind = 'card.assigned'`, `data = {toUserId, mode}`,
   `actor_id` = РОП или NULL.
6. Уведомление на получателя: `INSERT INTO notifications (id, user_id, kind, params, dedupe_key, not_before,
   created_at) VALUES (…, 'cards_assigned', {"count": n}, 'assign:<runId>:<user>', $now, $now)
   ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`. Текста и ПДн нет; колокол — P8a.

Строки 3–6 строит чистая `assignRows` (assign.ts). Её **паритет с ядром** — unit-тест: для снимка карточки
пула `calling.applyOutcome({ event: { type: 'assign', mode, toUserId, runId, … } })` даёт те же владельца,
`assignedAt`, `version + 1`, `touchedInCrm = false`, вид и `countsToCap` журнала, данные ленты и
`dedupeKey` уведомления. Так раздача пишет пакетом, но смысл перехода № 2 один (D-173).

## 4. Двойники, `heldBy`, блокировка пары (D-174)

Источник — `dup_pairs` со статусом `open` или `distinct` (`split_allowed` пару отпускает; `merged` — уже
один клиент). Для кандидата X и карточки Y клиента-напарника в том же пространстве:

| Y | Пара | Для X |
|---|---|---|
| в пуле, готова к раздаче | любая | `twins` (группа уходит одному); Y за пределом выборки — дочитать и добавить в кандидаты |
| `do_not_call` | `open` | `blocked` (общий номер с «Не звонить» — решает РОП, PROCESS 7.6) |
| есть владелец, состояние `new`/`retry`/`callback`/`agreed`/`client` | любая | `heldBy = Y.owner_user_id` |
| без владельца, но с задержкой (`hold_reason ≠ ''`) | `open` | `blocked` |
| закрыта (`not_interested`, `not_target`, `written_off`) или нет карточки | любая | ограничений нет |

Ядро `planAllocation` дальше само: группа целиком, владелец двойника вне раздачи → `heldBack`, разные
владельцы у группы → `heldBack`, места не хватает на группу → `overCap`. Общий номер без строки
`dup_pairs` раздача не ищет: пары создают приём (C3) и импорт (C4) — их тесты это проверяют.

SQL (repo.ts): кандидаты — §5.3; пары кандидатов —
`SELECT p.a_client_id, p.b_client_id, p.status FROM dup_pairs p WHERE p.status IN ('open','distinct') AND
(p.a_client_id = ANY($clients) OR p.b_client_id = ANY($clients))`; карточки напарников —
`SELECT id, client_id, owner_user_id, state, hold_reason FROM cards WHERE space_id = $s AND client_id = ANY($partners)`.

## 5. SQL (repo.ts)

5.1. Участники:
```sql
SELECT m.user_id, u.name, m.in_distribution, m.paused_on,
       (SELECT max(a.to_day) FROM absences a
         WHERE a.space_id = m.space_id AND a.user_id = m.user_id AND a.cancelled_at IS NULL
           AND $today BETWEEN a.from_day AND a.to_day) AS absent_until
  FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
 WHERE m.space_id = $space AND m.status = 'active' AND m.role_key = ANY($roles)
 ORDER BY u.name, m.user_id;
```
5.2. Открытые и выдано сегодня (по списку участников):
```sql
SELECT COALESCE(c.acting_user_id, c.owner_user_id) AS user_id,
       count(*) FILTER (WHERE c.state = 'new')::int AS open_new,
       count(*) FILTER (WHERE c.state = 'new' OR c.next_call_at <= $now)::int AS open
  FROM cards c
 WHERE c.space_id = $space AND c.hold_reason = '' AND c.state IN ('new','retry','callback')
   AND (c.owner_user_id = ANY($users) OR c.acting_user_id = ANY($users))
 GROUP BY 1;
SELECT to_user_id, kind, count(*)::int AS n FROM assign_log
 WHERE space_id = $space AND day = $today AND to_user_id = ANY($users) GROUP BY 1, 2;
```
5.3. Кандидаты (индекс `cards_pool_idx`):
```sql
SELECT c.id, c.client_id, c.version, c.created_at,
       EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.client_id AND p.is_working AND p.kind = 'mobile') AS has_mobile
  FROM cards c
 WHERE c.space_id = $space AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
 ORDER BY c.created_at, c.id LIMIT $limit;
```
Тик — без `scopeSql` (SystemActor, охват не ограничен). Чтения РОП (`getPool`, участники, журнал) — с
`scopeSql(viewer, 'card', 'pool.read')` для карточек; пул и журнал — разрешения с `minScope: 'space'`.
5.4. Сводка пула: `count(*) FILTER` по `hold_reason` среди `owner_user_id IS NULL AND state = 'new'`
(`cards_hold_idx`, `cards_pool_idx`); `pair_blocked` — число готовых, у которых §4 дал `blocked`
(считается по первым 1 000 готовым карточкам пула; этого хватает для сводки РОП).
5.5. Журнал: `SELECT day, min(created_at), kind, run_id, from_user_id, to_user_id, actor_id, count(*),
count(*) FILTER (WHERE counts_to_cap) FROM assign_log WHERE space_id = $s AND day BETWEEN $from AND $to
[AND (to_user_id = $u OR from_user_id = $u)] GROUP BY day, kind, run_id, from_user_id, to_user_id, actor_id
ORDER BY min(created_at) DESC LIMIT 500` + имена сотрудников (`users.name`). Период ≤ 31 день.

## 6. API (route handlers через `route()`; тела — Zod `.strict()`)

| Метод и путь | Разрешение, `target` | Тело / запрос | Ответ |
|---|---|---|---|
| `GET /api/distribution/pool` | `pool.read`, section | `cursor?`, `limit` 1–100 (50) | `PoolPage` |
| `GET /api/distribution/participants` | `pool.read`, section | — | `ParticipantView[]` |
| `PUT /api/distribution/participants/[userId]` | `distribution.manage`, object | `{ inDistribution }` | `ParticipantView`; не участник пространства → 404; аудит `distribution.participant` |
| `POST /api/distribution/issue` | `card.assign`, section | `{ opId: uuid, toUserId, cardIds?: id[1..100] } \| { opId, toUserId, count: 1..200 }` | `ManualIssueResult` |
| `GET /api/distribution/log` | `pool.read`, section | `from`, `to` (`YYYY-MM-DD`, ≤ 31 дн), `userId?` | `JournalRow[]` |

Ошибки: `over_cap` → 409 `{ error: 'over_cap', remaining, cap }`; `not_working`, `mode_off` → 409 с кодом;
`not_participant` → 400; `invalid_settings` → 409. Плохое тело — 400 (обёртка). Чужое пространство не
существует: охват `space` уже в `scopeSql`. Тексты — `messages/ru/distribution.json`.

## 7. Тесты

**Unit** (`tests/unit/distribution/*.test.ts`, дважды по поясам): разбор настроек (пресет `base` и накладка
ЦРП → `DistributionConfig`; мусор → `invalid_settings`); статус участника (пауза сегодня, отсутствие на
сегодня, оба → `absent`); `assignRows` паритет с ядром (§3.3); правила §4 таблицей (каждая строка — тест);
`job.schedule`: `auto_even` → `grid 08:00–18:00/60 workdays`, `manual`/`off` → `null`.

**Интеграционные** (`tests/integration/distribution/*.test.ts`, Postgres 16, синтетика +7 709):
- `tick`: 3 оператора × лимит 40, пул 150 → 40/40/40, 30 в пуле; журнал 120 строк `auto`, `counts_to_cap`;
  лента `card.assigned`; по одному уведомлению на оператора; повтор того же `runId` → `already_applied`,
  ничего не добавилось; новый `runId` → 0 (лимит исчерпан);
- календарь: `slotAt` 26.10.2026 и суббота → `not_workday_or_window`, ни одной строки; 07:00 и 19:00 → то же;
  `mode = manual` → `mode_manual`;
- лимит (PROCESS 7.3, D-039): у оператора сегодня 25 `manual` и 5 `return` (сид журнала) → тик даёт 10;
  «вернуть в пул» (строка `release`) не возвращает лимит;
- пары (PROCESS 12.11, 12.12): три клиента с общим номером → все три одному; двойник у оператора B →
  карточка ему же, при исчерпанном лимите B → в пуле (`heldBack`); напарник в `do_not_call` (`open`) →
  `blocked`; `split_allowed` → раздаются независимо;
- пауза и отсутствие: такие операторы ничего не получают; `in_distribution = FALSE` — тоже;
- гонка с импортом: параллельно транзакция держит `FOR UPDATE` на 5 карточках пула → тик их пропускает
  (`raced = 5`), не ждёт дольше 1 с; двойник пропущенной карточки тоже остаётся в пуле;
- гонка тик ‖ ручная выдача тому же оператору (20 прогонов): выдано всего ≤ лимита, без дублей в журнале;
- ручная выдача: сверх остатка → 409 `over_cap`, ничего не выдано; повтор `opId` → `replayed`, без новых
  строк; выбранная карточка с двойником в пуле → выданы обе; `heldBy` другого → `pair_held`; на паузе →
  `not_working`; `capOverride = true` → проходит;
- журнал: группировка по прогону и виду; период > 31 дня → 400.

**Изоляция** (`tests/isolation/manifest/distribution.ts` + прогон): оператор A — 403 на все маршруты
раздела (нет `pool.read`, `card.assign`); РОП другого пространства не видит пул; `PUT participants/[userId]`
с чужим userId → 404; мутации РОП меняют только `cards`, `assign_log`, `client_events`, `notifications`,
`memberships`, `audit_log`. Директор (только чтение) → 423 на `issue` и `PUT`.

**Нагрузка** (Q1c, 25.10): 10 операторов, 5 000 в пуле, 400 выдач за тик ≤ 5 с — интеграционный тест с
замером (`tests/integration/distribution/tick-load.test.ts`, предел 5 с на CI).

## 8. Нужно от других

| Что | Кто | Когда |
|---|---|---|
| строка `distributeJob` в `src/server/jobs/registry.ts` | координатор (T0) после влития P7 | 23.10 |
| перенос `DISTRIBUTION_LOCK_KEY` в `platform/db/locks.ts` (значение то же) | platform | после влития |
| C6b: «вернуть в пул», «Отсутствует» (с журналом `absence`: при снятии временного владельца — строка `to_user_id = владелец`, чтобы C5 правильно считал «был владельцем в момент звонка»), «Пауза» — под тем же `DISTRIBUTION_LOCK_KEY` | base (C6b) | 24.10 |
| C6c: возвраты «Не интересует» в начале тика | base | неделя 2 |

## 9. Чего builder C6a НЕ делает

Не пишет «Пауза», «Отсутствует», «вернуть в пул» и раздел «Без владельца (не новые)» (C6b), возвраты (C6c),
входящие лиды (`inbound`), интерфейс РОП (§10), колокол и тексты уведомлений (P8a), спрос `demand` (готов в
C3); не вызывает `calling.applyOutcome` в рантайме (только в тесте паритета); не меняет схему (миграция не
нужна); не трогает реестр воркера и `locks.ts`.

## 10. Разбивка работ

| № | Задача | Уровень | Кто |
|---|---|---|---|
| 1 | `errors.ts`, `deps.ts`, `index.ts`, `messages/ru/distribution.json`, NAMESPACES, строки аудита | T0 | mechanic |
| 2 | `settings.ts`, `assign.ts` + unit (паритет, правила §4, расписание) | T1 | builder |
| 3 | `repo.ts`, `participants.ts`, `pool.ts`, `tick.ts`, `manual.ts`, `journal.ts`, `job.ts` + интеграционные §7 | T1 (по дизайну T2→T1) | builder |
| 4 | маршруты §6, манифест, изоляция | T1 | builder |
| 5 | экран РОП `(mgr)/distribution`: участники с переключателем, пул с выбором и «Раздать выбранные», журнал | T1 | builder (после 4) |
| 6 | ревью блокировок, SKIP LOCKED, лимита и пар | T2 | reviewer |
