# Задачи, «Отсутствует», карточка клиента, архив, передача и слияние — дизайн B7 · C6b · C8 · C9 · B9a · B9b

Статус: дизайн architect, 24.10.2026. Нормативно: PROCESS §2.2, §2.9, §3.5 (№ 3, 11–15, 22–24), §6, §7.5–7.6,
§8.3–8.5, §9, §12.11–12.12, §12.15, §12.20–12.21, §12.24; CONFIG §6.10, §6.12, §6.16; D-038…D-042, D-049, D-050,
D-062, D-066, D-068, D-072, D-126, D-173…D-176, D-224; решения этого дизайна **D-251…D-260**. Все примеры —
синтетика (+7 709 …, «ТОО Пример»). Next 16: перед маршрутами и страницами прочитай
`node_modules/next/dist/docs/` (route handlers, `params` — Promise). Ядро — только корень `@crm/core`.

Обозначения: `S(entity, perm)` = `${scopeSql(viewer, entity, perm)}` внутри `scoped(sql)`; «ядро» — чистые
функции `@crm/core`; «тх» — `db.tx` с повтором при 40P01/40001 до 3 раз (как `calls/tx.ts`).

---

## 0. Что когда (PLAN §4, §6.1)

| Часть | Поток | Входит | Срок влития |
|---|---|---|---|
| §1 общий помощник ручных переходов карточки | calling | пилот (нужен C6b) | 24.10 13:00 |
| §1.4 `reassign_open` в `deals/effects.ts` | booking | пилот (нужен C6b, B9a) | 24.10 13:00 |
| §2 **C6b**: «Отсутствует», «Пауза», «Без владельца (не новые)» | base | **пилот** | 25.10 19:00 |
| §3 **C8**: карточка клиента — поля карточки, история правок, заметки, итоговый отчёт, история сделок, «Записать», меню | calling | **пилот** (поля и правки обязательно; заметки, отчёт, сделки — режутся в этом порядке снизу в 0.9.1) | 25.10 19:00 |
| §4 **B7**: задачи | booking | 01.11 | 27.10 |
| §5 **C9**: архив, «Мои клиенты», «Вернуть в обзвон», «Снять «Не звонить»», закрытие из меню, «Предложить контакт» | calling + base | 01.11 | 27.10 |
| §6 **B9a**: передача одним действием, отключение с передачей дел, «срочно», массовая | manager | 01.11 (массовая — за `FEATURE_BULK_TRANSFER`) | 28.10 |
| §7 **B9b**: спорные пары, слияние с предпросмотром | base | 01.11 (слияние — за `FEATURE_MERGE`) | 28.10 |

Заморозка `0.9.0` — 26.10 12:00: к ней влиты §1, §1.4, §2, §3. Всё остальное — `0.9.x`/`1.0.0`.

---

## 1. Общее: ручные переходы карточки (D-251), блокировки, задачи при передаче (D-254)

### 1.1. `src/server/domain/cards/manual.ts` (calling, сигнатуры — ниже, реализует builder)

Один путь для всех ручных и системных событий карточки, кроме итога звонка: `release`, `absence`,
`transfer`, `reopen`, `dnc_clear`, `close_from_menu`, `merge`. Логика — только ядро `calling.applyOutcome`.

```ts
// cards/manual.ts
export type CardEventPerm = 'card.outcome' | 'card.edit' | 'card.assign' | 'card.return' | 'card.unblock' | 'client.transfer' | 'client.merge';

/** Применить событие к уже заблокированной карточке: ядро → persistTransition. `rejected` не бросает. */
export async function applyCardEventLocked(
  tx: Sql, actor: CardActor, row: LockedCardRow, ctx: CallingContext,
  event: calling.TransitionEvent, now: number, opts?: { opId?: string },
): Promise<calling.TransitionResult>;

/** Тх: lockCardScoped(viewer, cardId, perm) → build(snapshot) → applyCardEventLocked. Нет карточки — NotFoundError. */
export async function runCardEvent(
  viewer: Viewer, cardId: string, perm: CardEventPerm,
  build: (snap: calling.CardSnapshot) => calling.TransitionEvent,
  opts?: { opId?: string; inTx?: (tx: Sql, after: calling.AppliedResult) => Promise<void> },
): Promise<calling.AppliedResult>;
```

- `lockCardScoped` (cards/repo.ts, cards/types.ts): тип `perm` расширить до `CardEventPerm` — `scopeSql` уже
  умеет любое разрешение.
- `PersistInput` получает необязательный `opId`; `persistTransition` кладёт его в `EffectCard.opId`, если
  у перехода нет звонка. Так `assign_log.run_id` ручного действия = `opId` запроса (идемпотентность
  выдач, D-173).
- Ответ ядра `rejected` → `CardActionError(code)`: `version_conflict` → 409 `{error:'card_changed'}` с
  актуальной версией; `invalid_transition` → 409 `invalid_state`; `comment_required`, `reason_required` →
  400; `user_inactive` → 400 `user_inactive`.
- Ручные действия — только онлайн; повтор с той же версией получает 409 `card_changed`, интерфейс
  перечитывает карточку (PROCESS 3.5, абзац после таблицы).

### 1.2. Единый порядок блокировок

`IMPORT_APPLY_LOCK_KEY` → `INTAKE_LOCK_KEY` → `DISTRIBUTION_LOCK_KEY` → строки `clients` по `id` → строки
`cards` по `id` → мероприятия → записи → прочее. Первой командой каждой тх, берущей advisory, —
`SET LOCAL lock_timeout = '10s'`. Нарушение порядка — замечание P1 ревью.

### 1.3. Задачи при передаче и слиянии (D-254, правка calling)

`tasks/auto.ts` `reassignOpenTasks` сейчас переназначает **все** открытые задачи клиента, включая задачи РОП
без исполнителя (`review`, `stoplist_confirm`). Правка (calling, T1, 24.10): вход
`{ spaceId, clientId, fromUserIds: string[], toUserId, at }`, условие
`AND t.assignee_user_id = ANY(${fromUserIds})`; `cards/effects.ts` передаёт `[card.ownerUserId,
card.actingUserId]` **до** перехода (из `before`), без NULL. Тест: задача РОП без исполнителя и задача
консультанта после передачи остались у них.

### 1.4. `reassign_open` в `deals/effects.ts` (booking, T1, 24.10)

`UPDATE deals SET owner_user_id = $to, version = version + 1, updated_at = $at WHERE space_id = $s AND
client_id = $c AND status = 'open'` (индекс `deals_client_idx`). Выигранные и проигранные не трогать
(PROCESS 8.5). Ленты не пишет. Тест: открытая → у нового, выигранная — у прежнего.

---

## 2. C6b: «Отсутствует», «Пауза», «Без владельца (не новые)» (base, D-255, D-256)

### 2.1. Файлы

| Файл | Что |
|---|---|
| `packages/core/src/distribution/absence.ts` (+ `absence.test.ts`, экспорт в `index.ts`) | чистые `selectAbsenceCards`, `planActing` (§2.3) |
| `src/server/domain/distribution/absence.ts` | `createAbsence`, `cancelAbsence`, `listAbsences`, `applyAbsences` (тх, §2.4) |
| `src/server/domain/distribution/ownerless.ts` | `listOwnerless`, `assignOwnerless` (§2.6) |
| `src/server/domain/distribution/participants.ts` | + `setPause` |
| `src/server/domain/distribution/repo.ts` | SQL §2.5 |
| `src/server/domain/distribution/job.ts` | + `absenceJob` (`daily 07:30 all`, perSpace, writes `business`) |
| `src/server/domain/distribution/types.ts` | `AbsenceView`, `OwnerlessItem`; `PoolSummary.ownerless: number` |
| `src/app/api/distribution/absences/route.ts` | `GET`, `POST` |
| `src/app/api/distribution/absences/[id]/cancel/route.ts` | `POST` |
| `src/app/api/distribution/participants/[userId]/route.ts` | тело `{inDistribution}` **или** `{paused}` |
| `src/app/api/distribution/ownerless/route.ts`, `ownerless/assign/route.ts` | `GET`, `POST` |
| `src/app/(mgr)/distribution/AbsencePanel.tsx`, `OwnerlessPanel.tsx`; правка `ParticipantsPanel.tsx`, `PoolPanel.tsx` | экран РОП |
| `messages/ru/distribution.json` | ключи §9 |
| `tests/isolation/manifest/distribution.ts` | новые маршруты |

### 2.2. Модель

- **Пауза** — `memberships.paused_on = сегодня` (местные сутки). Только сегодня; снять — `''`. Ставит РОП
  (`distribution.manage`). Тик и ручная выдача уже читают статус (C6a). Самопаузы оператора к 01.11 нет
  (вопрос владельцу В-1).
- **Отсутствует** — строка `absences` (`from_day…to_day` включительно, `substitute_user_id` или NULL =
  «поровну»). У сотрудника не больше одного неотменённого отсутствия на любой день (пересечение → 409
  `overlap`). Длина ≤ 60 дней, `to_day ≥ сегодня`. «Изменить даты» = отменить + создать.
- **Какие карточки** отсутствующего `U` получают временного владельца (`acting_user_id`,
  `acting_until_day = to_day`), ядро `absence` (№ 23):
  - `retry`/`callback` с `next_call_at < начало дня после to_day` (включая уже наступившие);
  - `agreed`/`client` с записью `registered|confirmed`, у которой `booking_date ∈ [max(from_day, сегодня),
    следующий рабочий день после to_day]` — чтобы напоминание накануне видел временный (D-255);
  - нетронутые `new` (`calls_total = 0`) → в пул (ядро возвращает `release`);
  - карточки, где `U` сам временный владелец (замещал коллегу), → новому временному, срок прежний.
  - Закрытые и `hold_reason = 'merged'` не трогаются.
- **Применение** — сразу при создании, если `from_day ≤ сегодня`, и ежедневно задачей `absence` в 07:30
  (подхватывает карточки, срок которых попал в отсутствие позже). Повтор идемпотентен: карточка с уже
  заданным временным не трогается.
- **Снятие**: задача `absence` снимает `acting_*` у карточек с `acting_until_day < сегодня`; отмена
  отсутствия снимает сразу у всех карточек `owner = U`. Строка `assign_log` `kind='absence'`,
  `from = временный`, `to = владелец` (нужна D-175 «был владельцем в момент звонка»), лента `card.acting`
  `{actingUserId: null, untilDay: ''}`. Ядро события снятия не имеет — запись пакетом, тест паритета
  полей с ядром не нужен (меняются только два поля и версия).
- **Задачи** отсутствующего временный видит через охват (D-252, §4.6), без переназначения.

### 2.3. Ядро (`packages/core/src/distribution/absence.ts`)

```ts
export interface AbsenceCardRow { cardId: string; clientId: string; state: CardState; callsTotal: number;
  nextCallAt: number | null; hasBookingInWindow: boolean; actingUserId: string | null; actingUntilDay: string; }
export type AbsenceAction = { cardId: string; action: 'release' | 'acting'; actingUserId?: string; untilDay?: string };
/** Какие карточки трогать (правила §2.2). `endMs` — начало местного дня после to_day. */
export function selectAbsenceCards(rows: readonly AbsenceCardRow[], endMs: number): AbsenceCardRow[];
/** Временный на каждую карточку: заданный или «поровну» — группа двойников целиком одному, меньше нагрузка → раньше; равенство — порядок кандидатов. */
export function planActing(cards: readonly { cardId: string; groupKey: string }[],
  who: { substitute: string } | { even: readonly { userId: string; load: number }[] }, untilDay: string): AbsenceAction[];
```

`groupKey` — наименьший `client_id` группы двойников (`dup_pairs` `open|distinct`, как D-174). Unit: каждая
строка §2.2 — тест; «поровну» 7 карточек на 3 кандидата с нагрузкой 0/2/0 → 3/1/3; группа из 3 двойников не
делится; пустой список кандидатов → пусто (сервер отвечает `no_substitute`).

### 2.4. Транзакции

**`createAbsence(viewer, {opId, userId, fromDay, toDay, substituteUserId|null})`**, тх:
```
SET LOCAL lock_timeout = '10s'; pg_advisory_xact_lock(DISTRIBUTION_LOCK_KEY)
повтор: SELECT … FROM absences WHERE id = $opId  → прежний AbsenceView, replayed
участник U: активное членство в viewer.spaceId, активный сотрудник           иначе 404
даты: 400 dates; пересечение (absences_user_idx):
  SELECT 1 FROM absences WHERE space_id=$s AND user_id=$u AND cancelled_at IS NULL AND from_day <= $to AND to_day >= $from  → 409 overlap
заместитель: участник (participantRoles), ≠ U, активен, без отсутствия, пересекающего [max(from,сегодня), to] → иначе 409 substitute_absent
INSERT INTO absences (id, space_id, user_id, from_day, to_day, substitute_user_id, created_by, created_at) VALUES ($opId, …)
writeAudit('distribution.absence', entity 'distribution', entityId = U, meta {fromDay, toDay, even: bool})
если from_day ≤ сегодня → applyAbsences(tx, viewer, {spaceId, absence, today})
```
**`applyAbsences(tx, actor, {spaceId, absence, today})`**: снимок кандидатов §2.5.2 → `selectAbsenceCards` →
кандидаты «поровну» §2.5.3 → `planActing` → по каждой карточке в порядке `id`: `lockCardUnscoped` (карточки
уже отобраны под охватом РОП или системой) → `applyCardEventLocked(…, {type:'absence', actingUserId,
untilDay}, now, {opId: absence.id})`. Уведомление каждому временному: `kind 'absence_acting'`, `params
{count}`, `dedupe_key = absence:<absenceId>:<userId>:<today>`. Нет кандидатов при «поровну» → карточки
остаются у владельца, уведомление руководителю (`resolveLead`) `absence_no_substitute` `{count}`.

**`cancelAbsence(viewer, id)`**: тх, advisory; `UPDATE absences a SET cancelled_at = $now WHERE a.id = $id
AND a.space_id = $s AND a.cancelled_at IS NULL RETURNING a.user_id` (0 строк: нет → 404, уже отменено →
прежний ответ); снятие временных §2.5.4 для `owner = U`; аудит `distribution.absence_cancel`.

**Задача `absence`** (SystemActor, по пространству): тх, advisory; снятие по сроку §2.5.4; для каждого
отсутствия, активного сегодня, — `applyAbsences`. Отчёт `{ended, released, acting}` в `job_runs.stats`.
Строку в `src/server/jobs/registry.ts` добавляет координатор (T0).

**`setPause(viewer, {userId, paused})`**: тх, advisory; `UPDATE memberships m SET paused_on = $v, updated_at
= $now WHERE m.user_id = $u AND m.space_id = $s AND m.status = 'active' RETURNING …` (0 → 404); аудит
`distribution.pause` `{paused}`. Пауза отсутствующего разрешена (ничего не меняет).

### 2.5. SQL (`distribution/repo.ts`)

2.5.1. Список отсутствий (экран): `SELECT a.*, u.name, su.name AS substitute_name FROM absences a JOIN users u
ON u.id = a.user_id LEFT JOIN users su ON su.id = a.substitute_user_id WHERE a.space_id = $s AND
a.cancelled_at IS NULL AND a.to_day >= $today ORDER BY a.from_day, u.name LIMIT 200`.

2.5.2. Карточки отсутствующего (индексы `cards_queue_idx`, `bookings_client_idx`, `cards_acting_idx`):
```sql
SELECT c.id, c.client_id, c.state, c.calls_total, c.next_call_at, c.acting_user_id, c.acting_until_day,
       EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.client_id AND b.space_id = c.space_id
                 AND b.status IN ('registered','confirmed') AND b.booking_date BETWEEN $winFrom AND $winTo) AS has_booking
  FROM cards c
 WHERE c.space_id = $s AND c.owner_user_id = $u AND c.acting_user_id IS NULL AND c.hold_reason <> 'merged'
   AND c.state IN ('new','retry','callback','agreed','client');
-- отдельно: замещал коллегу
SELECT c.id, c.client_id, c.state, c.acting_until_day FROM cards c
 WHERE c.space_id = $s AND c.acting_user_id = $u;
```
2.5.3. Кандидаты «поровну» и нагрузка: участники как C6a §5.1 без `U` и без отсутствия, пересекающего
период; нагрузка — C6a §5.2 `open`.

2.5.4. Снятие временных (индекс `cards_acting_idx`):
```sql
SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id FROM cards c
 WHERE c.space_id = $s AND c.acting_user_id IS NOT NULL
   AND (($owner::text IS NULL AND c.acting_until_day < $today) OR c.owner_user_id = $owner)
 ORDER BY c.id FOR UPDATE OF c;
UPDATE cards SET acting_user_id = NULL, acting_until_day = '', version = version + 1, updated_at = $now WHERE id = ANY($ids);
INSERT INTO assign_log (…kind 'absence', from_user_id = acting, to_user_id = owner, counts_to_cap = FALSE, run_id = $runId, day, actor_id…) SELECT … FROM unnest(…);
INSERT INTO client_events (…kind 'card.acting', data {"actingUserId": null, "untilDay": ""}…) SELECT … FROM unnest(…);
```
2.5.5. Сводка пула: `ownerless = count(*) FROM cards WHERE space_id = $s AND owner_user_id IS NULL AND state <>
'new' AND hold_reason <> 'merged'` (`cards_queue_idx`). Её же читает R1b.

### 2.6. «Без владельца (не новые)» (страховочный раздел, в норме пуст, D-066)

- `listOwnerless(viewer, {cursor, limit ≤ 100})`: `SELECT c.id, c.client_id, cl.name, c.state, c.next_call_at,
  c.version, c.created_at FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE c.space_id = $s AND
  c.owner_user_id IS NULL AND c.state <> 'new' AND c.hold_reason <> 'merged' AND S('card','pool.read') AND
  (c.created_at, c.id) > ($cAt, $cId) ORDER BY c.created_at, c.id LIMIT $n`.
- `assignOwnerless(viewer, {opId, toUserId, items: [{cardId, version}] 1..100})`, тх, advisory:
  повтор — есть строки `assign_log` с `run_id = opId` → прежний итог; получатель — участник `working`
  (иначе 409 `not_working`); по каждой карточке в порядке `id`: `lockCardScoped(viewer, id, 'card.assign')`,
  всё ещё без владельца и не `new` (иначе `skipped: changed`) → `applyCardEventLocked({type:'transfer',
  toUserId, seenVersion: item.version, facts: {toUserActive: true}}, {opId})`. Лимит не расходуется
  (`transfer`, D-039). Аудит `distribution.ownerless_assign` `{count, skipped}`.

### 2.7. API (через `route()`, тела Zod `.strict()`)

| Метод и путь | `perm`, `target` | Тело / запрос | Ответ |
|---|---|---|---|
| `GET /api/distribution/absences` | `pool.read`, section | — | `AbsenceView[]` |
| `POST /api/distribution/absences` | `distribution.manage`, section | `{opId: uuid, userId, fromDay, toDay, substituteUserId: string \| null}` | `AbsenceView & {applied: {acting, released}}` |
| `POST /api/distribution/absences/[id]/cancel` | `distribution.manage`, object (`absence`) | — | `AbsenceView` |
| `PUT /api/distribution/participants/[userId]` | `distribution.manage`, object | `{inDistribution: boolean} \| {paused: boolean}` | `ParticipantView` |
| `GET /api/distribution/ownerless` | `pool.read`, section | `cursor?`, `limit` | `{items: OwnerlessItem[], next}` |
| `POST /api/distribution/ownerless/assign` | `card.assign`, section | `{opId, toUserId, items: [{cardId, version}]}` | `{assigned, skipped: {cardId, reason}[]}` |

Ошибки: `overlap`, `substitute_absent`, `no_substitute`, `not_working` → 409; `dates` → 400. Директор → 423.

### 2.8. Интерфейс РОП (`(mgr)/distribution`, ноутбук и телефон)

- Участники: у строки меню «Пауза на сегодня» / «Снять паузу», «Отсутствует…». Статус = `Badge` (цвет +
  значок + текст): «Работает», «Пауза», «Отсутствует до 30.10».
- «Отсутствует…» — `Modal`/`BottomSheet`: даты «с — по» (по умолчанию сегодня), «Кому передать: [сотрудник]
  / Поровну между работающими». После сохранения `Toast` «Временно передано: 9, вернулось в пул: 3».
  Ниже — список отсутствий с «Отменить».
- Пул: вкладка «Без владельца (не новые)» со счётчиком; выбор строк + «Назначить» (получатель) →
  `assign`. Пусто → `EmptyState` «Здесь пусто — так и должно быть».
- Карточка клиента (C8) показывает «Временно ведёт: Оператор Б до 30.10» (поле уже есть: `actingName`).

---

## 3. C8: карточка клиента (calling, D-259)

### 3.1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/clients/types.ts` | `CardHeadDto` + `version`, `ownerUserId`, `actingUntilDay`, `closeReasonCode`, `closedAt`, `returnAt`, `fields` (проекция полей объекта `card`); `ClientCardDto.can` (§3.6); `ClientPage` + `summary`, `pinnedNotes`, `deals` |
| `src/server/domain/clients/service.ts`, `repo.ts` | сбор DTO, `updateCardFields` |
| `src/server/domain/timeline/notes.ts`, `summary.ts`, `deals.ts` | заметки, итоговый отчёт, история сделок (SQL — в `timeline/repo.ts`) |
| `src/server/domain/timeline/kinds.ts` | фильтр `edits` (§3.2); вид `note.created` уже есть; возврат в обзвон отдельного вида не требует — ядро пишет `card.state` с `cause: 'reopen'` |
| `src/app/api/cards/[id]/route.ts` | `PATCH` поля карточки |
| `src/app/api/clients/[id]/notes/route.ts`, `src/app/api/clients/notes/[id]/route.ts` | `POST`, `PATCH` |
| `src/app/api/clients/[id]/summary/route.ts`, `[id]/deals/route.ts` | `GET` |
| `src/app/api/clients/[id]/feed/route.ts` | + параметры `group=edits`, `dealId` |
| `src/app/(op)/clients/_ui/{SummaryBlock,NotesPanel,DealsPanel,CardActions,CardFieldsPanel}.tsx` | интерфейс |
| `messages/ru/clients.json` | ключи §9 |
| `tests/isolation/manifest/clients.ts`, новый `tests/isolation/manifest/cards.ts` | маршруты |

### 3.2. Поля карточки и история правок

- Проекция `projectFor(viewer, 'card', fields, cards.custom)` в `CardHeadDto.fields`; правка —
  `PATCH /api/cards/[id]` `{version, set: {custom}, expect: {custom}}`, `card.edit`, object. Тх:
  `lockCardScoped(viewer, id, 'card.edit')` (нет → `throwNotFoundOrForbidden` как в C2) → версия ≠ →
  409 `card_changed` → `buildFieldValidator({object:'card', mode:'edit'})` → `writeCardCustom` →
  `version + 1` → лента `field.changed` `{obj:'card', field, before, after}` (как `calls/fields.ts`).
- «История правок» — фильтр ленты `group=edits` = виды `field.changed`, `phone.*`, `contact.*`
  (`kinds.ts`: `FEED_FILTERS.edits`). Отдельной таблицы нет: правки и так в ленте (D-125).

### 3.3. Заметки

- Заметка **не правится и не удаляется** (лента только добавляется; исправление — новая заметка). Можно
  закрепить/открепить (до 3 закреплённых, сверх — 409 `pin_limit`).
- `POST /api/clients/[id]/notes` `{opId, body 1..4000, dealId?}`, `note.write`, object. Тх:
  `SELECT cl.id FROM clients cl WHERE cl.id = $id AND S('client','note.write')` (нет → 404/403 по C2);
  `dealId` → `SELECT 1 FROM deals d WHERE d.id = $d AND d.client_id = $id AND S('deal','deal.read')` иначе 400;
  `INSERT INTO notes (id, client_id, space_id, deal_id, author_id, body, pinned, created_at) VALUES ($opId,
  $id, $space, $deal, $me, $body, FALSE, $now) ON CONFLICT (id) DO NOTHING RETURNING id`; 0 строк →
  повтор своего `opId` с тем же клиентом → прежняя, иначе 400 `op_id`; лента `note.created` `{noteId}`,
  `ref_type 'note'`, `deal_id`.
- `PATCH /api/clients/notes/[id]` `{pinned: boolean}`, `note.write`, object: `UPDATE notes n SET pinned =
  $p WHERE n.id = $id AND S('note','note.write') RETURNING …` (0 → чтение `S('note','card.read')`: 404/403).
- Чтение: закреплённые — `SELECT … FROM notes n WHERE n.client_id = $id AND n.space_id = $s AND n.pinned AND
  S('note','card.read') ORDER BY n.created_at DESC LIMIT 3` (`notes_client_idx`); в ленте текст события
  `note.created` подтягивается по `ref_id` из `notes` (одним запросом по id страницы) вместе с именем автора.

### 3.4. Итоговый отчёт по клиенту (PROCESS 9.3, D-259)

Сервер отдаёт **структуру без текста**; фразу строит интерфейс из локали. Только то, что зрителю видно.

```ts
export type ClientSummaryDto = {
  period: { from: number; to: number } | null;            // первый и последний звонок
  calls: { total: number; connects: number; noAnswer: number };  // счётчики карточки (PROCESS 9.2)
  lprFoundAt: number | null;
  bookings: { kind: 'group' | 'individual'; eventTypeKey: string; date: string; time: string;
              status: BookingStatus; consultantName: string | null }[];   // до 10, без 'moved'
  purchases: { serviceTypeKey: string; amountKzt: number; wonAt: number }[];
  handoffs: { teamKey: string; status: string; createdAt: number; acceptedAt: number | null }[];
  ownerName: string | null; actingName: string | null;
  nextStep: { kind: 'callback' | 'retry' | 'booking' | 'task' | 'none'; at: number | null; taskSource?: string };
};
```
SQL (`timeline/repo.ts`), каждый со своим охватом:
```sql
SELECT min(ca.occurred_at) AS f, max(ca.occurred_at) AS l, min(ca.occurred_at) FILTER (WHERE ca.lpr = 'yes') AS lpr_at
  FROM calls ca WHERE ca.client_id = $id AND ca.space_id = $s AND S('call','card.read');           -- calls_client_idx
SELECT b.kind, b.event_type_key, b.booking_date, b.start_time, b.status, u.name
  FROM bookings b LEFT JOIN resources r ON r.id = b.resource_id LEFT JOIN users u ON u.id = r.user_id
 WHERE b.client_id = $id AND b.space_id = $s AND b.status <> 'moved' AND S('booking','booking.read')
 ORDER BY b.starts_at DESC LIMIT 10;                                                               -- bookings_client_idx
SELECT d.service_type_key, d.amount_kzt, d.won_at FROM deals d
 WHERE d.client_id = $id AND d.space_id = $s AND d.status = 'won' AND S('deal','deal.read') ORDER BY d.won_at;
SELECT t.key, h.status, h.created_at, h.accepted_at FROM handoffs h JOIN teams t ON t.id = h.team_id
 WHERE h.client_id = $id AND h.space_id_from = $s AND S('handoff','handoff.read') ORDER BY h.created_at;
SELECT t.source, t.due_at FROM tasks t WHERE t.client_id = $id AND t.space_id = $s AND t.status = 'open'
   AND S('task','task.read') ORDER BY t.due_at NULLS LAST LIMIT 1;                                 -- tasks_client_idx
```
`nextStep`: `callback`/`retry` → `next_call_at`; иначе ближайшая будущая запись `registered|confirmed`; иначе
задача; иначе `none`. Блок в шапке, не редактируется. Пример фразы (локаль): «С 28.10 по 12.11: 4 звонка
(2 дозвона, 2 недозвона). ЛПР найден 29.10. Записан на БР 05.11 — пришёл. Покупка «SMM» 450 000 ₸ 12.11.
Владелец: Оператор А. Следующий шаг: нет.» Суммы — `Intl.NumberFormat('ru')`, без дробной части.

### 3.5. История сделок

`GET /api/clients/[id]/deals` (`deal.read`, object): `SELECT d.id, d.pipeline_key, d.stage_key, d.status,
d.service_type_key, d.amount_kzt, d.created_at, d.won_at, d.lost_at, d.lost_reason_code, u.name AS owner_name
FROM deals d LEFT JOIN users u ON u.id = d.owner_user_id WHERE d.client_id = $id AND d.space_id = $s AND
S('deal','deal.read') ORDER BY d.created_at DESC LIMIT 50`. Нажатие на сделку → лента с `dealId`
(`client_events_deal_idx`; до чтения — проверка видимости сделки тем же охватом, иначе 404). Подписи этапов
— из `pipelines` настроек (`deals/pipelines.ts`).

### 3.6. Действия карточки (`ClientCardDto.can`, меню `CardActions`)

Сервер считает `can` по правам зрителя и состоянию; интерфейс только показывает.

| Кнопка | `can.*` | Условие | Куда | Чья задача |
|---|---|---|---|---|
| «Позвонить» | — | есть рабочий номер | `tel:` (есть) | C2 |
| «Записать» | `book` | `booking.create` и состояние `agreed`/`client` | `/bookings/new/[cardId]` | C8 |
| «Задача» | `task` | `task.write` | шторка новой задачи (B7) | B7 |
| «Не целевой…», «Полный отказ…» | `closeFromMenu` | `card.outcome` и переход допустим (№ 11, 12) | §5.3 | C9 |
| «Вернуть в обзвон» | `reopen` | `card.return`, состояние `not_target`/`written_off`/`not_interested` | §5.3 | C9 |
| «Снять «Не звонить»» | `unblock` | `card.unblock`, `do_not_call` | §5.3 | C9 |
| «Передать…» | `transfer` | `client.transfer` | §6 | B9a |

C8 делает меню и кнопки «Записать»; пункты C9/B7/B9a появляются, когда `can.*` начнёт приходить `true`
(до их влития сервер отдаёт `false`).

---

## 4. B7: задачи (booking, D-252, D-253)

### 4.1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/tasks/types.ts` | + DTO и сигнатуры §4.3 (auto-часть не трогать) |
| `src/server/domain/tasks/sources.ts` | таблица источников §4.2 |
| `src/server/domain/tasks/repo.ts` | SQL §4.4 |
| `src/server/domain/tasks/service.ts` | `listTasks`, `getTask`, `createTask`, `updateTask`, `completeTask`, `cancelTask`, `addComment`, `listAssignees`, `listClientTasks` |
| `src/server/domain/tasks/settings.ts` | `tasks.askNextStep`, календарь (предупреждение о нерабочем сроке) |
| `src/server/domain/tasks/index.ts` | + экспорт сервиса |
| `src/app/api/tasks/route.ts` | `GET` список, `POST` создать |
| `src/app/api/tasks/[id]/route.ts` | `GET` задача с комментариями, `PATCH` |
| `src/app/api/tasks/[id]/{done,cancel,comments}/route.ts` | `POST` |
| `src/app/api/tasks/assignees/route.ts` | `GET ?clientId=` |
| `src/app/(op)/tasks/page.tsx` + `_ui/*` | **одна** страница `/tasks` для всех ролей (две группы на один URL роняют `next build`; `(mgr)/tasks` не создавать) |
| `src/app/(op)/tasks/_ui/ClientTasksPanel.tsx` | открытые задачи клиента для карточки (подключает calling одной строкой) |
| `src/server/domain/timeline/kinds.ts` | строки `task.created`, `task.done`, `task.cancelled`, `task.comment` (группа `tasks`) |
| `src/server/platform/audit.ts` | — (задачи не аудируются) |
| `messages/ru/tasks.json` + `'tasks'` в `NAMESPACES` | §9 |
| `tests/isolation/manifest/tasks.ts` | все маршруты и страница |

### 4.2. Источники: что можно сделать вручную (D-253)

| `source` | Закрыть вручную («Готово») | Действие в строке |
|---|---|---|
| `manual` | да; «Отменить» — автор или охват `space` | — |
| `callback`, `no_show`, `rebook`, `clarify_import` | **нет**: проекция срока карточки (D-050), закрывает итог | «Открыть карточку» |
| `agreement`, `next_step` | **нет**: инвариант D-049, закрывает запись или итог | «Записать» |
| `attendance_mark` | **нет**: закрывает отметка явки | «Открыть мероприятие» |
| `handoff` | **нет**: закрывает «Принять» | «Открыть передачу» |
| `grey_unassigned` | **нет**: закрывает назначение консультанта | «Записи» |
| `inbound_message`, `missed_call`, `dnc_inbound`, `review`, `proposal`, `absent_review`, `staff_disabled`, `stoplist_confirm` | да | «Открыть карточку» |

Нельзя закрыть — сервер отвечает 409 `auto_task`. Срок и заголовок меняются только у `manual`; исполнителя
можно сменить у любой открытой задачи (с `task.assign_others`) и «взять себе» задачу без исполнителя.

### 4.3. Сигнатуры

```ts
export type TaskView = 'mine' | 'team' | 'unassigned' | 'done';
export type TaskBucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';
export interface TaskRow { id: string; clientId: string; clientName: string | null; dealId: string | null;
  kind: TaskKind; source: TaskSource; title: string; dueAt: number | null; bucket: TaskBucket;
  assigneeUserId: string | null; assigneeName: string | null; comments: number; closable: boolean;
  status: 'open' | 'done' | 'cancelled'; doneAt: number | null; }
export interface TaskList { items: TaskRow[]; counts: Record<TaskBucket, number>; truncated: boolean }
export type ListTasks = (viewer: Viewer, q: { view: TaskView; userId?: string; clientId?: string }) => Promise<TaskList>;
export type CreateTask = (viewer: Viewer, b: { opId: string; clientId: string; dealId?: string | null;
  kind: Exclude<TaskKind, 'handoff'>; title: string; dueAt: number | null; assigneeUserId: string })
  => Promise<{ task: TaskRow; warnings: ('due_outside_work_hours')[] }>;
export type CompleteTask = (viewer: Viewer, id: string, b: { comment?: string }) => Promise<{ task: TaskRow; askNext: boolean }>;
export type AddComment = (viewer: Viewer, taskId: string, b: { opId: string; body: string }) => Promise<TaskCommentDto>;
```

### 4.4. SQL (`tasks/repo.ts`)

Список открытых (`view = mine`; индекс `tasks_assignee_idx`; ветка временного — `cards_acting_idx`):
```sql
SELECT t.id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.assignee_user_id, au.name AS assignee_name,
       t.status, t.done_at,
       (SELECT cl.name FROM clients cl WHERE cl.id = t.client_id AND S('client','client.read', {alias:'cl'})) AS client_name,
       (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comments
  FROM tasks t LEFT JOIN users au ON au.id = t.assignee_user_id
 WHERE t.status = 'open' AND t.space_id = $s
   AND (t.assignee_user_id = $me
        OR EXISTS (SELECT 1 FROM cards ca WHERE ca.space_id = t.space_id AND ca.client_id = t.client_id
                    AND ca.acting_user_id = $me AND ca.owner_user_id = t.assignee_user_id))
   AND S('task','task.read')
 ORDER BY t.due_at NULLS LAST, t.created_at, t.id LIMIT 301;
```
`team`: вместо условия исполнителя — `($userId::text IS NULL OR t.assignee_user_id = $userId)` (индекс
`tasks_space_due_idx`); `unassigned`: `t.assignee_user_id IS NULL`; `done`: `t.status IN ('done','cancelled')
AND t.done_at >= $now - 7 дн AND (assignee = $me …)` `ORDER BY t.done_at DESC LIMIT 100`; `clientId` —
`t.client_id = $c` (`tasks_client_idx`). 301-я строка → `truncated: true`.
Счётчики корзин — отдельный запрос с теми же условиями: `count(*) FILTER (WHERE t.due_at < $now)`,
`… >= $now AND < $tomorrowStart`, `… < $afterTomorrowStart`, `… >= $afterTomorrowStart`, `… IS NULL`; границы
дней — начало местных суток в поясе установки (`time`), параметрами. «Просрочена» = срок прошёл, задача
открыта (PROCESS 6.3).

Создание (`createTask`), тх:
```
повтор: SELECT … FROM tasks WHERE id = $opId → created_by = me и тот же client_id → прежняя; иначе 400 op_id
карточка клиента видна: SELECT c.owner_user_id, c.acting_user_id FROM cards c
  WHERE c.client_id = $client AND c.space_id = $s AND S('card','card.read') → нет: 404
сделка (если есть): того же клиента, S('deal','deal.read') → иначе 400 deal
исполнитель: = me → да; иначе нужно can(viewer,'task.assign_others') (иначе 403) и исполнитель ∈ listAssignees(client)
INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
  VALUES ($opId, $s, $client, $deal, $kind, 'manual', $title, $due, $assignee, 'open', NULL, $me, $now)
лента task.created {taskId, kind, assigneeUserId, dueAt}
исполнитель ≠ me → notifications (kind 'task_assigned', entity 'task', params {}, dedupe 'task:<id>:assigned')
срок вне рабочего времени → warnings ['due_outside_work_hours'] (не запрет, PROCESS 6.3)
```
`listAssignees(viewer, clientId)` (D-253): я; владелец и временный владелец карточки; активные сотрудники
пространства, чья роль (по настройкам) даёт `task.read` с охватом `space`/`all` и не `readOnly`;
консультанты с живой индивидуальной записью клиента в окне `booked_with_me` (`consultantWindowDates`). Всем,
кроме меня, — только при `task.assign_others`. Так исполнитель всегда видит свою задачу.

Изменение, выполнение, отмена: `UPDATE tasks t SET … WHERE t.id = $id AND t.status = 'open' AND
S('task','task.write') [AND t.source = 'manual' для срока, заголовка и отмены] RETURNING …`; 0 строк →
чтение с `S('task','task.read')`: не видна → 404; закрыта → для `done` прежний ответ (повтор), иначе 409
`closed`; не тот источник → 409 `auto_task`. «Готово» с комментарием — комментарий в той же тх. Ответ
`askNext = tasks.askNextStep[viewer.roleKey] === true` → интерфейс предлагает «Создать следующую?» (форма
с тем же клиентом). Лента `task.done`/`task.cancelled` `{taskId, source}`.

Комментарии: чтение — `SELECT tc.id, tc.body, tc.created_at, u.name FROM task_comments tc JOIN tasks t ON
t.id = tc.task_id LEFT JOIN users u ON u.id = tc.author_id WHERE tc.task_id = $id AND S('task','task.read')
ORDER BY tc.created_at, tc.id` (`task_comments_task_idx`); запись — сначала `SELECT 1 FROM tasks t WHERE
t.id = $id AND S('task','task.write')` (нет → 404/403), затем `INSERT … (id = $opId) ON CONFLICT (id) DO
NOTHING`; лента `task.comment` `{taskId, commentId}` (текста в ленте нет); уведомление исполнителю, если
пишет не он (`task_comment`, dedupe `task:<id>:comment:<commentId>`). Комментарий 1..2000 символов.

### 4.5. Интерфейс `/tasks` (телефон оператора, ноутбук РОП)

- Вкладки (`Tabs`): «Мои» · у кого `task.read` шире `own` — «Команда» и «Без исполнителя» · «Выполненные».
  В «Команде» — фильтр по сотруднику (`Select`).
- Группы «Просрочено / Сегодня / Завтра / Позже / Без срока» со счётчиками; просрочено — красный текст +
  значок + слово «Просрочено» (не только цвет).
- Строка: подпись (у `manual` — `title`, у остальных — из локали по `source`), клиент, срок, исполнитель
  (в «Команде»), число комментариев. Нажатие → `BottomSheet`/`Modal`: детали, комментарии, поле
  комментария, одна primary-кнопка по таблице §4.2 («Готово» или переход).
- «+ Задача» (на карточке клиента и в списке через поиск своего клиента): тип, название, срок (быстрые
  «Сегодня 18:00», «Завтра 10:00», своё), исполнитель (список `assignees`, по умолчанию я).
- Карточка клиента: `ClientTasksPanel` — открытые задачи клиента (тот же `GET /api/tasks?clientId=`).
- Перезвоны недозвона и «Напомнить» в задачах **не** хранятся (PROCESS 6.2); ссылки «Мои перезвоны» и
  «Записи → Напомнить» — над списком.

### 4.6. Охват задач временного владельца (D-252, правка platform)

`src/server/access/scope.ts` `taskPred.own()`: `(X.assignee_user_id = me OR EXISTS (SELECT 1 FROM cards
acc_ta WHERE acc_ta.space_id = X.space_id AND acc_ta.client_id = X.client_id AND acc_ta.acting_user_id = me
AND acc_ta.owner_user_id = X.assignee_user_id)) AND <карточка видна>`. Это задача platform (T2: architect
пишет, reviewer проверяет), 26.10 не нужна, к B7 27.10. Тест изоляции: временный видит задачи владельца по
карточкам, где он временный, и только их; после снятия — 404.

---

## 5. C9: архив, «Мои клиенты», возврат, закрытие из меню, «Предложить контакт» (calling + base, D-258, D-260)

### 5.1. Архив и «Мои клиенты» — виды списка клиентов

Отдельных таблиц и API нет: `GET /api/clients` получает `view`:
- `view=mine` — `c.state IN ('agreed','client')` и `(c.owner_user_id = $me OR c.acting_user_id = $me)`;
- `view=archive` — `c.state IN ('not_interested','not_target','do_not_call','written_off')`, сортировка
  `c.closed_at DESC NULLS LAST, c.id`, курсор по `(closed_at, id)`; у РОП фильтр `owner=<userId>`;
- во всех видах `c.hold_reason <> 'merged'`.
Охват как сейчас (`S('card','client.read')`): оператор видит свой архив, РОП — весь (PROCESS 2.9).
Страница `/archive` (`src/app/(op)/archive/page.tsx`, пункт меню уже есть): строка — название, состояние
(`Badge`), причина (подпись из `reasons`), дата закрытия, «вернётся DD.MM» у `not_interested`. На странице
`/clients` вкладки «Все · Мои клиенты» (вторая — `view=mine`).

### 5.2. Маршруты действий карточки (calling, `src/app/api/cards/[id]/**`, через `runCardEvent`)

| Путь | `perm` | Тело | Событие ядра |
|---|---|---|---|
| `POST /api/cards/[id]/reopen` | `card.return` | `{opId, version, comment 1..500, toUserId?}` | `transfer` (если нужен) → `reopen` |
| `POST /api/cards/[id]/dnc-clear` | `card.unblock` | `{opId, version, comment 1..500}` | `dnc_clear` |
| `POST /api/cards/[id]/close` | `card.outcome` | `{opId, version, kind: 'not_target'\|'do_not_call', reasonCode, alsoDncPhoneIds: id[]}` | `close_from_menu` |

- **«Вернуть в обзвон»** (№ 14, D-260): если владелец пуст или отключён — `toUserId` обязателен (400
  `owner_required`), в той же тх сначала `transfer`, затем `reopen` (вторая версия = первая + 1). Иначе
  карточка вернулась бы к тому, кто её не увидит.
- Комментарий возврата и снятия «Не звонить» сохраняется **заметкой** (`notes`, автор — РОП) в той же тх:
  ядро текст не хранит, а лента — только коды. Аудит: `card.reopen` `{cardId, fromState}`;
  `card.dnc_cleared` уже пишет ядро.
- Закрытие из меню — оператору тоже (О, Р): «Не целевой» и «Полный отказ» без звонка; причина обязательна.
- Ответ: `{card: CardHeadDto}`; ошибки §1.1.

### 5.3. Интерфейс

Пункты меню `CardActions` (§3.6): диалог с комментарием (и получателем, если сервер ответил
`owner_required`); «Полный отказ» — список номеров с отметками «тоже не звонить» (основной отмечен).

### 5.4. «Предложить контакт» (base: сервис в `intake`; calling: маршрут и экран, D-258)

Файлы: `src/server/domain/intake/propose.ts` (сервис, base), `src/server/domain/intake/index.ts` (+экспорт),
`src/server/domain/distribution/tick.ts` (+выдача предложений, base), `src/server/domain/distribution/proposals.ts`
(разбор РОП, base), `src/app/api/clients/proposals/route.ts` (calling), `src/app/api/distribution/proposals/**`
(base), экран оператора `src/app/(op)/clients/_ui/ProposeSheet.tsx` (calling), раздел пула «Предложены
операторами» в `(mgr)/distribution` (base).

`POST /api/clients/proposals` `{opId, phone, name 1..200}`, `client.propose`, section → `proposeContact`,
**ответ всегда 202 `{status:'accepted'}`** (и на повтор). Тх:
```
lockIntake                                         -- D-022
повтор: proposals.id = $opId → user_id = me → 202; чужой → 400 op_id
parsePhone(phone, rules): не номер / не рабочий формат → 400 phone_invalid  (формат, не наличие в базе)
used    = count phone_probes (user, сегодня)        -- общий счётчик D-040 (тот же, что add_phone)
stopped = stop_list по phoneHmac; taken = phoneTakenElsewhere(digits)  (любой не слитый клиент)
INSERT phone_probes (path 'proposal', matched = stopped OR taken)
режим раздачи не авто (manual/off) ИЛИ used >= security.phoneProbesPerDay ИЛИ stopped ИЛИ taken:
    INSERT proposals (id=$opId, space_id, user_id, digits, name, status 'review', matched_client_id = <первый клиент номера> | NULL)
    used >= лимита → уведомление руководителю 'probe_limit' {count}, dedupe 'probe_limit:<user>:<day>'
иначе:
    клиент (source_kind 'proposal', name, name_norm, search_norm — функции intake), номер, карточка new без владельца
    в viewer.spaceId, лента client.created / card.created, INSERT proposals (status 'created', client_id)
```
**Выдача предложившему** — первым шагом тика (`runTick`, в той же тх под `DISTRIBUTION_LOCK_KEY`, до плана):
```sql
SELECT p.user_id, c.id, c.client_id, c.version FROM proposals p
  JOIN cards c ON c.client_id = p.client_id AND c.space_id = p.space_id
  JOIN users u ON u.id = p.user_id AND u.status = 'active'
  JOIN memberships m ON m.user_id = p.user_id AND m.space_id = p.space_id AND m.status = 'active'
 WHERE p.space_id = $s AND p.status = 'created' AND p.created_at >= $now - 14 дн
   AND c.owner_user_id IS NULL AND c.state = 'new' AND c.hold_reason = ''
 ORDER BY c.id FOR UPDATE OF c SKIP LOCKED;          -- индекс proposals_pending_idx (миграция §7.6)
```
→ `writeAssignBatch({kind: 'proposal', countsToCap: capIncludes ∋ 'proposal'})` (D-039: у ЦРП не входит).
Пауза и отсутствие предложившего выдачу не останавливают (это его находка); отключён — карточка остаётся
обычной карточкой пула. Ручная выдача РОП может забрать такую карточку раньше тика — допустимо.

**Разбор РОП** («Пул: Предложены операторами»): `GET /api/distribution/proposals` (`pool.read`): строки
`status = 'review'` (`proposals_review_idx`), номер и название целиком (РОП видит), имя предложившего,
совпавший клиент (название — через `S('client','client.read')`). `POST
/api/distribution/proposals/[id]/resolve` `{opId, decision: 'create' | 'reject'}` (`card.assign`): тх
`INTAKE` → `DISTRIBUTION`; `create` — клиент и карточка как выше, сразу владелец = предложивший
(`assign_log kind 'proposal'`), при общем номере — `dup_pairs` `shared_phone` (`a < b`, `ON CONFLICT DO
NOTHING`); `reject` — `status 'rejected'`. `resolved_by`, `resolved_at`; аудит `proposal.resolve`.

Экран оператора: «Предложить контакт» в меню «Ещё» и на `/clients` → `BottomSheet` (номер, название) →
`Toast` «Принято. Карточка появится в очереди после проверки» (одинаково всегда).

---

## 6. B9a: передача клиента, отключение сотрудника (manager, D-254, D-255)

### 6.1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/team/transfer.ts` | `transferOne`, `previewBulk`, `transferBulk`, `planEven` (чистая) |
| `src/server/domain/team/transferRepo.ts` | пакетная запись §6.3 |
| `src/server/domain/team/handover.ts` | реализация `StaffHandover` (`urgent`, `wizard`) вместо заглушки |
| `src/server/domain/team/schemas.ts`, `service.ts` | `DisableInput` + получатели мастера; вход `HandoverInput` + `viewer` |
| `src/server/domain/team/purge.ts` | `purgeChangeSnapshots(actor, before)` (часть `purge`, 30 дней) |
| `src/app/api/team/transfers/{one,preview,bulk}/route.ts` | §6.5 |
| `src/app/api/team/staff/[id]/handover-preview/route.ts` | счётчики для мастера |
| `src/app/(mgr)/team/{TransferScreen,DisableDialog}.tsx`, `src/app/(mgr)/team/transfer/page.tsx` | интерфейс |
| `src/server/platform/audit.ts` | `client.transfer`, сущность `client` |
| `messages/ru/team.json` | §9 |
| `tests/isolation/manifest/team.ts` | маршруты |

### 6.2. Что переносит передача (PROCESS 8.5, № 22, ядро `applyTransfer`)

Для каждой карточки `card → to`: `owner_user_id = to`, `acting_* = ''/NULL`, `version + 1`; открытые задачи
клиента в пространстве, **исполнитель которых — прежний владелец или временный**, → `to` (D-254); открытые
сделки → `to`; будущие `registered|confirmed` записи → ответственный `to` (автор не меняется, D-042);
`assign_log` `transfer` (лимит не расходуется); лента `card.transferred`; уведомление получателю
`client_transferred` `{count}` одно на получателя и операцию (`dedupe transfer:<opId>:<to>`).

**Двойники идут вместе** (D-038, D-254): к выбранной карточке добавляются карточки той же группы
(`dup_pairs` `open|distinct`) с **тем же владельцем** в рабочих состояниях. Диалог показывает «Вместе с
клиентом передаются связанные: N».

### 6.3. Пакетная запись (`transferRepo.ts`, семантика ядра как D-173)

```
SET LOCAL lock_timeout = '10s'; pg_advisory_xact_lock(DISTRIBUTION_LOCK_KEY)
SELECT c.* FROM cards c WHERE c.id = ANY($ids) AND c.space_id = $s ORDER BY c.id FOR UPDATE OF c   -- ждём, не SKIP
[снимок, если bulk/handover] INSERT INTO change_snapshots (id, operation_id, kind, table_name, row_id, client_id, before, created_by, created_at)
   SELECT gen_random_uuid()::text, $op, 'bulk_transfer', 'cards', c.id, c.client_id, to_jsonb(c), $actor, $now FROM cards c WHERE c.id = ANY($ids)
   — то же для tasks (открытые, клиенты набора, исполнитель ∈ прежних), deals (open), bookings (будущие активные)
UPDATE cards c SET owner_user_id = w.to, acting_user_id = NULL, acting_until_day = '', version = c.version + 1, updated_at = $now
  FROM unnest($ids::text[], $tos::text[]) w(id, to) WHERE c.id = w.id
UPDATE tasks t SET assignee_user_id = w.to FROM unnest($clients, $froms, $actings, $tos) w(client, f, a, to)
 WHERE t.space_id = $s AND t.client_id = w.client AND t.status = 'open' AND t.assignee_user_id IN (w.f, w.a)   -- tasks_client_idx
UPDATE deals d SET owner_user_id = w.to, version = d.version + 1, updated_at = $now FROM unnest(...) w
 WHERE d.space_id = $s AND d.client_id = w.client AND d.status = 'open'                                       -- deals_client_idx
UPDATE bookings b SET responsible_user_id = w.to, version = b.version + 1, updated_at = $now FROM unnest(...) w
 WHERE b.space_id = $s AND b.client_id = w.client AND b.status IN ('registered','confirmed') AND b.starts_at > $now  -- bookings_client_idx
INSERT INTO assign_log (… kind 'transfer', counts_to_cap FALSE, run_id $op, day, actor_id …) SELECT … FROM unnest(…)
INSERT INTO client_events (… kind 'card.transferred', data {fromUserId, toUserId} …) SELECT … FROM unnest(…)
INSERT INTO notifications (… 'client_transferred', params {"count": n}, dedupe 'transfer:<op>:<to>' …) ON CONFLICT DO NOTHING
writeAudit('client.transfer', entity 'client' | 'user', meta {count, recipients, mode})
```
Unit-тест паритета: для одной карточки строки пакета = результат `calling.applyOutcome({type:'transfer'})`
(владелец, временный снят, `version + 1`, вид журнала, лента, вид уведомления).
Повтор `opId`: есть `assign_log` с `run_id = opId` и `kind = 'transfer'` → прежний итог.

### 6.4. Режимы

- **Одиночная** `transferOne(viewer, {opId, cardId, version, toUserId})`: `client.transfer`; `version` главной
  карточки ≠ → 409 `card_changed`; получатель — активный сотрудник пространства, чья роль даёт
  `card.outcome` (не `readOnly`), ≠ текущий владелец; снимка нет (D-062: снимок — для массовых).
- **Массовая** (`FEATURE_BULK_TRANSFER`, выключен — 404): `from` (сотрудник), охват `working` (по умолчанию:
  `new` с владельцем, `retry`, `callback`, `agreed`, `client`) или `all` (+ архив), получатель один или
  «поровну» 2–20. `planEven(families, recipients)`: семьи по убыванию размера, затем по наименьшему id;
  каждая — получателю с наименьшей суммой; равенство — порядок списка. Предпросмотр: счётчики по
  состояниям, задач, сделок, записей, семей; применение в одной тх; ≤ 5 000 карточек (больше → 400
  `too_many`, делить по состояниям).
- **Отключение «срочно»** (D-066, D-255) — всегда, при любой лицензии (мутация безопасности
  `team.disable_user`), в тх `disableStaff`, по каждому пространству, где было членство:
  1. получатель: отключающий, если его роль в этом пространстве даёт `card.outcome` с охватом
     `space`/`all` и не `readOnly`; иначе первый активный сотрудник роли `team.fallbackOwnerRole`
     (`memberships.created_at, user_id`), не отключаемый; никого — `status 'no_recipient'`, карточки остаются
     за отключённым, тревога администратору;
  2. нетронутые `new` → пул (`release`), лимит не возвращается;
  3. рабочие (`retry`, `callback`, `agreed`, `client`, `new` со звонками) → получателю (§6.3, со снимком);
  4. где он временный владелец → `acting = получатель`, срок прежний (`assign_log absence`);
  5. оставшиеся его открытые задачи в пространстве, будущие записи (ответственный) и открытые сделки →
     получателю;
  6. его неотменённые отсутствия → `cancelled_at`;
  7. уведомление получателю `staff_disabled` `{count}` (dedupe `staff_disabled:<user>:<space>`) со ссылкой
     на `/team/transfer?from=<получатель>&op=<opId>` — список полученных карточек для разбора.
  Закрытые карточки остаются за отключённым (архив); возврат «Не интересует» уйдёт в пул (12.24).
- **Отключение с мастером** (`FEATURE_BULK_TRANSFER`): шаги 2, 4–6 как «срочно», шаг 3 — выбранному или
  «поровну». Без флага интерфейс предлагает только «срочно».

Инвариант после любого режима: `countOwnerlessWorkingCards() = 0` и нет рабочей карточки у отключённого
(если получатель был). Тест — интеграционный и часть `invariants` (есть).

### 6.5. API

| Метод и путь | `perm`, `target` | Тело / запрос | Ответ |
|---|---|---|---|
| `POST /api/team/transfers/one` | `client.transfer`, object (`card`) | `{opId, cardId, version, toUserId}` | `{moved, related}` |
| `GET /api/team/transfers/preview` | `client.transfer`, section | `from`, `scope=working\|all` | `{cards: Record<state, n>, families, tasks, deals, bookings}` |
| `POST /api/team/transfers/bulk` | `client.transfer`, section | `{opId, fromUserId, scope, to: {userId} \| {even: userId[]}}` | `{moved, byRecipient}` |
| `GET /api/team/staff/[id]/handover-preview` | `admin`, object | — | как preview + `actingCards`, `recipient` |
| `POST /api/team/staff/[id]/disable` | `admin`, object, `securityMutation: 'team.disable_user'` | `{mode:'urgent'} \| {mode:'wizard', to}` | `DisableResult` |

### 6.6. Интерфейс

- Карточка клиента: «Передать…» → выбор сотрудника → подтверждение (с числом связанных) → `Toast`.
  Прежний владелец на следующем действии получает 404 и видит «Карточка вам больше недоступна» (C7a, есть).
- `/team/transfer` (РОП): «От кого», «Что: рабочие / все», «Кому: одному / поровну», предпросмотр
  счётчиками, одна primary-кнопка «Передать N карточек».
- `/team` (администратор): «Отключить…» → «Срочно» (по умолчанию) или «С передачей дел» (за флагом), сводка
  предпросмотра, предупреждение «Вход закроется сразу».

---

## 7. B9b: спорные пары и слияние (base, D-257)

### 7.1. Файлы

| Файл | Что |
|---|---|
| `src/server/domain/distribution/pairs.ts` | `listPairs`, `resolvePair` (`distinct`, `split_allowed`) |
| `src/server/domain/intake/merge.ts`, `mergeRepo.ts` | `previewMerge`, `applyMerge`, `MERGE_TABLES` |
| `src/app/api/distribution/pairs/route.ts`, `pairs/[id]/resolve/route.ts`, `pairs/[id]/merge-preview/route.ts`, `pairs/[id]/merge/route.ts` | API |
| `src/app/(mgr)/pairs/page.tsx` + `_ui/*` | экран РОП |
| `migrations/2026-10-28-base-fix-merge-and-proposals.sql` | §7.6 (оформляет координатор) |
| `src/server/domain/timeline/kinds.ts` | `client.merged` `{otherClientId}` (группа `system`) — строка от base |
| `src/server/platform/audit.ts` | `client.merge`, `pair.resolve`, `proposal.resolve`; сущности `client`, `pair` |
| `messages/ru/pairs.json` + `'pairs'` в `NAMESPACES` | §9 |

Слияние живёт в `intake` (рядом с дедупом и `clientForMerge`), а не в `clients` (ARCHITECTURE §2.3): так
задача остаётся в зоне base. Описательную строку ARCHITECTURE правит координатор.

### 7.2. Пары

`GET /api/distribution/pairs?status=open` (`pool.read`): `SELECT p.id, p.a_client_id, p.b_client_id, p.reason,
p.status, p.created_at FROM dup_pairs p WHERE p.status = $st ORDER BY p.created_at LIMIT 100`
(`dup_pairs_open_idx`) + по каждой стороне карточка пространства через `S('card','pool.read')` (название,
номера, состояние, владелец); пара, у которой ни одной стороны не видно, не выводится.
`POST …/[id]/resolve` `{decision: 'distinct' | 'split_allowed', comment}` (`card.assign`): `split_allowed`
требует комментарий, если общий номер рабочий у обеих сторон (PROCESS 7.6); `UPDATE dup_pairs SET status,
comment, resolved_by, resolved_at WHERE id = $id AND status = 'open'`; тх под `DISTRIBUTION_LOCK_KEY`
(раздача читает пары). Аудит `pair.resolve`.

### 7.3. Слияние: предпросмотр и применение (`FEATURE_MERGE`, выключен — 404)

`GET …/[id]/merge-preview?survivor=a|b&owner=auto|survivor|other` (`client.merge`): читает обе стороны без
блокировок и возвращает план: итоговое состояние и владелец (ядро `applyMerge` на снимках), число
переносимых строк по таблицам `MERGE_TABLES`, дубли номеров, заполняемые пустые поля, конфликты и
`fingerprint` = sha256 канонического JSON (id и `updated_at` клиентов, id и `version` карточек, отсортированные
id переносимых строк). Конфликты (слияние запрещено, 409 в применении):
- у обоих живые групповые записи на одно мероприятие, или будущие активные записи одного вида
  мероприятия (PROCESS 12.18) → `booking_conflict` (РОП сначала отменяет одну);
- карточка любой стороны в пространстве, где у РОП нет `client.merge`, → `other_space`.

`POST …/[id]/merge` `{opId, survivor, owner, fingerprint}` (`client.merge`). Тх:
```
lock_timeout; INTAKE_LOCK_KEY; DISTRIBUTION_LOCK_KEY
повтор: change_snapshots с operation_id = $opId и loser.merged_into_id = survivor → прежний ответ
клиенты FOR UPDATE ORDER BY id; оба не слиты; пара open; карточки обеих сторон FOR UPDATE ORDER BY id (S('card','client.merge'))
пересчитать план; fingerprint ≠ → 409 changed; конфликт → 409 <код>
снимок: каждую изменяемую и удаляемую строку (to_jsonb) в change_snapshots kind 'merge'
1. номера проигравшего: цифры есть у выжившего → DELETE (снимок); иначе UPDATE client_id, is_primary = FALSE
2. UPDATE client_id → выживший: contacts, client_sources, import_rows, messenger_chats, proposals (client_id и matched_client_id),
   handoffs, notes, tasks, deals, bookings, calls
3. карточки в каждом пространстве:
   - у обоих: ядро applyMerge(card = выжившего, other = проигравшего, ownerFrom) через applyCardEventLocked
     (эффекты: задачи, сделки, записи, журнал merge, уведомление card_merged проигравшему владельцу, аудит card.merged);
     calls/deals/bookings.card_id проигравшей → выжившей;
     проигравшая карточка: owner NULL, acting NULL, acting_until_day '', next_call_at NULL, hold_reason 'merged', version + 1
   - только у проигравшего: UPDATE cards SET client_id = выживший
4. клиент-проигравший: merged_into_id = выживший, updated_at  (сначала он: частичные уникальные индексы БИН и ИИН)
5. выживший: пустые поля ← проигравшего (legal_form, org_id, iin_hmac, region, address, email, website, ключи custom, которых нет);
   search_norm пересчитать (функции intake); updated_at
6. dup_pairs: эта пара → 'merged'; прочие пары проигравшего (X ≠ выживший) → новая (least, greatest, reason) с тем же статусом
   ON CONFLICT DO NOTHING, старая → 'merged'; пара (проигравший, выживший) по другой причине → 'merged'
7. лента client.merged {otherClientId} у выжившего; аудит client.merge {survivorId, loserId, counts}
```
Лента, согласия и аудит **не переносятся** (D-068): читаются по цепочке `merged_into_id`. `assign_log` и
`skips` остаются у проигравшей карточки (история). Карточку проигравшего открыть нельзя: страница клиента
уже ведёт к выжившему (`findSurvivor`), очереди и пул её не видят (`hold_reason = 'merged'`).

`MERGE_TABLES` — константа: каждая таблица с FK на `clients(id)` или `cards(id)` и что с ней делает слияние
(`move`, `chain`, `keep`). Интеграционный тест читает FK из `pg_constraint` и падает, если FK есть, а строки в
`MERGE_TABLES` нет (PROCESS 12.20 «список таблиц проверяется тестом»).

### 7.4. Интерфейс `/pairs` (ноутбук РОП)

Две колонки сторон (название, БИН, номера с отметкой общего, состояние, владелец, последняя активность),
причина пары. Кнопки: «Разные — тому же оператору», «Выдать другому…» (комментарий), «Объединить…» (за
флагом) → предпросмотр: «Остаётся: [A|B]», «Владелец: по последнему итогу / A / B», таблица «что
переедет», конфликты красным текстом со значком; «Объединить» активна без конфликтов.

### 7.5. Откат

Ручной, по `change_snapshots` (`operation_id`), 30 дней — `crmctl` после 01.11. Снимок пишется до первой
правки в той же тх.

### 7.6. Миграция (оформляет координатор; добавляющая, идемпотентная, D-037, D-059)

```sql
-- Слияние (D-257): проигравшая карточка остаётся строкой с задержкой 'merged'; «Предложить контакт» (D-258).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cards'::regclass
                  AND conname = 'cards_hold_reason_check' AND pg_get_constraintdef(oid) LIKE '%merged%') THEN
    ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_hold_reason_check;
    ALTER TABLE cards ADD CONSTRAINT cards_hold_reason_check
      CHECK (hold_reason IN ('','dup_pair','import_conflict','no_working_phone','rule','merged'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS proposals_pending_idx ON proposals (space_id, created_at) WHERE status = 'created';
CREATE INDEX IF NOT EXISTS proposals_client_idx  ON proposals (client_id) WHERE client_id IS NOT NULL;
```
`cards_hold_idx` (`hold_reason <> ''`) покрывает `merged`. Пул и очередь уже требуют `hold_reason = ''`.
`DELETE` новым таблицам не нужен. Файл должен быть влит **до** C9 и B9b (27.10 утром).

---

## 8. Права и изоляция (сводно)

| Действие | Оператор (own) | РОП (space) | Директор (readOnly) | Консультант |
|---|---|---|---|---|
| Задачи: свои, комментарии, «Готово» | свои по своим клиентам | все в пространстве | читать | свои (окно) |
| Задача другому | нет | да (`task.assign_others`) | 423 | нет |
| Заметка | свои клиенты | да | 423 | в окне (`booked_with_me`) |
| Пауза, отсутствие, без владельца, пары | 403 | да | 423 / читать пул | 403 |
| Возврат, снятие «Не звонить» | 404 (нет права = как нет объекта) | да | 423 | 404 |
| Закрытие из меню | свои | да | 423 | 404 |
| Передача, массовая | 403/404 | да | 423 | 403 |
| Слияние | 403 | да (флаг) | 423 | 403 |
| Отключение | — | только администратор | — | — |

Манифесты: `tests/isolation/manifest/{tasks,cards}.ts` (новые), дополнения в `clients.ts`, `distribution.ts`,
`team.ts`. Особые проверки прогона:
- после передачи клиента A → B: у A сразу 404 на клиента, заметки, сделки, задачи, ленту; `GET /api/tasks`
  A без задач клиента; уведомление B без названия клиента;
- временный владелец B видит карточку и задачи владельца A только на время отсутствия; после отмены — 404;
- оператор A: `POST /api/tasks/<задача B>/comments` → 404, `task_comments` не изменилась; `GET /api/tasks?view=team`
  → 403; список A не содержит id задач B; `clientName` чужого клиента в задаче отсутствует;
- `POST /api/clients/proposals` A с номером клиента B и со свободным номером — одинаковые тело и код ответа;
- слияние, пары, отсутствия, пул без владельца — оператору 403, директору 423 на мутации.

---

## 9. Тексты (`messages/ru`, только ключи и смысл; стоп-слова клиента запрещены)

- `tasks.json`: `tabs.{mine,team,unassigned,done}`, `buckets.{overdue,today,tomorrow,later,none}`,
  `source.<каждый source>` (подпись автозадачи), `kind.<каждый kind>`, `actions.{done,cancel,openCard,book,
  openEvent,openHandoff,take,comment,newTask,createNext}`, `form.{title,due,assignee,kind,quick.today,
  quick.tomorrow}`, `warn.dueOutsideWork`, `errors.{auto_task,closed,forbidden,deal,op_id}`, `empty.*`.
- `distribution.json`: `status.{working,paused,absent}`, `absence.{title,from,to,substitute,even,saved,
  cancel,list,applied}`, `pause.{set,unset}`, `ownerless.{tab,assign,empty}`, `proposals.{tab,create,reject}`,
  `errors.{overlap,substitute_absent,no_substitute,dates}`.
- `clients.json`: `summary.*` (шаблоны фраз 9.3 с ICU-плюрализацией), `notes.{title,add,pin,unpin,
  pin_limit}`, `deals.{title,empty,status.*}`, `feed.filter.edits`, `actions.{book,reopen,unblock,close,
  transfer,task}`, `archive.{title,returns}`, `tabs.{all,mine}`, `propose.{title,phone,name,accepted}`,
  `errors.{card_changed,owner_required,invalid_state}`.
- `team.json`: `transfer.{title,from,scope.working,scope.all,to.one,to.even,preview,submit,related}`,
  `disable.{urgent,wizard,warning,noRecipient}`.
- `pairs.json`: `title`, `reason.{shared_phone,name_and_head}`, `actions.{distinct,split,merge}`,
  `merge.{survivor,owner.auto,owner.a,owner.b,moves,conflict.booking_conflict,conflict.other_space,changed}`.
- `notify.json` (manager, T0): `kind.{task_assigned,task_comment,absence_acting,absence_no_substitute,
  staff_disabled,probe_limit,card_merged,client_transferred,card_reopened}`.

---

## 10. Тесты

**Unit** (`TZ=UTC` и `TZ=Asia/Almaty`):
- `packages/core/src/distribution/absence.test.ts` — правила §2.2 построчно, «поровну», группы двойников;
- `tests/unit/tasks/{sources,buckets,assignees}.test.ts` — таблица §4.2, корзины на границах суток
  (23:59/00:00 местного), «Пт 17:00 срок» на выходной → предупреждение;
- `tests/unit/team/{planEven,transferParity}.test.ts` — паритет пакета с ядром `transfer`; семьи не делятся;
- `tests/unit/timeline/summary.test.ts` — `nextStep` по приоритету; `tests/unit/intake/mergePlan.test.ts` —
  конфликты, заполнение только пустых полей.

**Интеграционные** (Postgres 16, синтетика +7 709):
- C6b `tests/integration/distribution/absence.test.ts`: отсутствие 28–30.10 у A: перезвон 29.10 и
  просроченный — временному B, перезвон 05.11 — нет, гость БР 29.10 и БК 31.10 (следующий рабочий) —
  временному, нетронутая новая — в пул (журнал `release`); «поровну» на B и C фиксирует по карточке;
  повтор задачи `absence` ничего не меняет; 31.10 07:30 временные сняты, журнал `absence` к владельцу;
  отмена — снято сразу; пересечение → 409; итог B по временной карточке — `applied`, итог A в отсутствие —
  по D-175; пауза: тик ничего не выдаёт, назавтра выдаёт; без владельца: назначение двух карточек,
  повтор `opId` — без дублей.
- C8 `tests/integration/clients/{notes,summary,deals,card-fields}.test.ts`: заметка повтором `opId` —
  одна; закрепить 4-ю → 409; отчёт не показывает записи и сделки, которых зритель не видит; правка поля
  карточки с устаревшей версией → 409.
- B7 `tests/integration/tasks/*.test.ts`: оператор не может назначить задачу другому (403) и задачу на
  чужого клиента (404); РОП назначает консультанту без окна → 400 `assignee`; «Готово» у `callback` →
  409 `auto_task`; комментарий повтором — один; временный видит задачу владельца (после правки охвата).
- C9 `tests/integration/{cards/manual-actions,intake/propose,distribution/proposal-tick}.test.ts`: возврат
  из `not_target` → `callback`, «Целевой: не выяснено», заметка с комментарием, аудит; у отключённого
  владельца без `toUserId` → 400; снятие «Не звонить» не удаляет номер, который держит другой клиент;
  предложение: свободный номер → клиент без владельца, следующий тик → предложившему (`proposal`, не в
  лимите); номер чужого → `review`, ответ тот же; 21-я проверка за день → `review` и уведомление РОП.
- B9a `tests/integration/team/{transfer,handover}.test.ts`: передача A → B: открытые сделки у B,
  выигранная у A, задача РОП без исполнителя не тронута, будущая запись — ответственный B, автор A;
  двойник идёт вместе; «срочно»: ни одной рабочей карточки без владельца, временные карточки → получателю,
  закрытые у A; `no_recipient` при отсутствии РОП; массовая «поровну» 3 получателя, 1 000 карточек ≤ 5 с,
  снимок = числу изменённых строк.
- B9b `tests/integration/intake/merge.test.ts`: все таблицы `MERGE_TABLES` перенесены (FK из
  `pg_constraint`); «Не звонить» побеждает; лента выжившего показывает события слитого; конфликт
  записей → 409; устаревший `fingerprint` → 409; повтор `opId` — тот же ответ; уникальный БИН переходит.

**Изоляция**: §8. **Нагрузка** (Q1c): `GET /api/tasks?view=team` p95 ≤ 300 мс на 20 000 задач;
применение отсутствия на 300 карточек ≤ 3 с.

**e2e, Pixel 7 (и iPhone 13)**:
- `tests/e2e/base-absence.spec.ts` — РОП ставит «Отсутствует» A с заместителем B; B на телефоне видит
  перезвон A в «Звонить» с пометкой «временно»; РОП отменяет — у B карточки нет;
- `tests/e2e/calling-client-card-c8.spec.ts` — заметка, закрепление, итоговый блок, история сделки,
  «Записать» ведёт в мастер;
- `tests/e2e/booking-tasks.spec.ts` — оператор: «+ Задача» на своём клиенте → «Сегодня» → комментарий →
  «Готово»; РОП: «Команда», фильтр по сотруднику, «Взять себе»;
- `tests/e2e/calling-archive.spec.ts` — РОП возвращает карточку из архива → она в очереди оператора;
  «Предложить контакт» → нейтральный ответ;
- `tests/e2e/manager-transfer.spec.ts` — передача A → B; A после обновления видит «Карточка вам больше
  недоступна»;
- `tests/e2e/base-merge.spec.ts` (флаг включён на стенде) — предпросмотр и слияние пары.

---

## 11. Нужно от других

| Что | Кто | Когда |
|---|---|---|
| `cards/manual.ts`, расширение `lockCardScoped`, `opId` в `persistTransition` (§1.1) | calling (T1) | 24.10 13:00 |
| `reassignOpenTasks` только по прежнему исполнителю (§1.3) | calling (T1) | 24.10 |
| `reassign_open` в `deals/effects.ts` (§1.4) | booking (T1) | 24.10 13:00 |
| строки `absenceJob` и `purgeChangeSnapshots` в `jobs/registry.ts` | координатор (T0) | после влития |
| `NAMESPACES`: `tasks`, `pairs` | координатор (T0) | до UI |
| строки `AUDIT_ACTIONS`/`AuditEntity`: `distribution.absence`, `distribution.absence_cancel`, `distribution.pause`, `distribution.ownerless_assign`, `card.reopen`, `client.transfer`, `client.merge`, `pair.resolve`, `proposal.resolve`; сущности `client`, `pair` | модули своими строками (T0) | с кодом |
| правка `taskPred.own()` (§4.6) | platform (architect пишет, reviewer T2) | 27.10 |
| миграция §7.6 | координатор | 27.10 утром |
| ключи `notify.json` (§9) | manager (T0) | с кодом |
| R1b: плитка «Без владельца» из `PoolSummary.ownerless` | manager | 25.10 |
| описательные правки: ARCHITECTURE §2.3 (слияние в `intake`), schema-v1 (новые индексы, `merged`) | координатор | после влития |

---

## 12. Разбивка задач и порядок

| № | Задача | Ур. | Кто | Зависит | Срок |
|---|---|---|---|---|---|
| 1 | §1.1 `cards/manual.ts` + `lockCardScoped` + `opId` в persist + unit | T2→T1 | builder (calling) | — | 24.10 13:00 |
| 2 | §1.3 `reassignOpenTasks` по прежнему исполнителю + тест | T1 | builder (calling) | — | 24.10 |
| 3 | §1.4 `deals` `reassign_open` + тест | T1 | builder (booking) | — | 24.10 13:00 |
| 4 | C6b: ядро `absence.ts` + unit | T1 | builder (base) | — | 24.10 |
| 5 | C6b: `absence.ts`, `ownerless.ts`, `setPause`, repo, job, маршруты, манифест, интеграционные §10 | T2→T1 | builder (base) | 1, 3, 4 | 25.10 13:00 |
| 6 | C6b: экран РОП §2.8, тексты | T1 | builder (base) | 5 | 25.10 19:00 |
| 7 | C8: поля карточки, фильтр правок, заметки, отчёт, сделки, `can`, маршруты, манифест, интеграционные | T2→T1 | builder (calling) | 1 | 25.10 13:00 |
| 8 | C8: интерфейс карточки §3, тексты | T1 | builder (calling) | 7 | 25.10 19:00 |
| 9 | ревью 1–8 (охват, блокировки, ПДн в ленте и уведомлениях) | T2 | reviewer | 1–8 | 25.10 |
| 10 | e2e `base-absence`, `calling-client-card-c8` на Pixel 7 и iPhone 13 | T1 | tester | 6, 8 | 26.10 до 12:00 |
| 11 | миграция §7.6 | T0 | mechanic (координатор) | — | 27.10 08:00 |
| 12 | правка охвата задач §4.6 + тест изоляции | T2 | architect → reviewer | — | 27.10 |
| 13 | B7: сервис, repo, маршруты, манифест, интеграционные | T2→T1 | builder (booking) | 12 | 27.10 |
| 14 | B7: `/tasks`, `ClientTasksPanel`, тексты; строка подключения в карточке (calling, T0) | T1 | builder (booking), mechanic | 13 | 27.10–28.10 |
| 15 | C9: виды списка, `/archive`, маршруты действий карточки, меню, интеграционные | T1 | builder (calling) | 1, 7 | 27.10 |
| 16 | C9: `intake/propose.ts`, выдача в тике, разбор РОП, интеграционные | T2→T1 | builder (base) | 11 | 27.10 |
| 17 | C9: шторка «Предложить контакт», раздел пула «Предложены» | T1 | builder (calling / base) | 16 | 28.10 |
| 18 | B9a: `transferRepo`, `transfer.ts`, `handover.ts`, маршруты, интеграционные, паритет | T2→T1 | builder (manager) | 1, 2, 3 | 28.10 |
| 19 | B9a: `/team/transfer`, диалоги, тексты | T1 | builder (manager) | 18 | 28.10 |
| 20 | B9b: пары, `merge.ts`, `MERGE_TABLES`-тест, маршруты, интеграционные | T2→T1 | builder (base) | 1, 11 | 28.10 |
| 21 | B9b: `/pairs`, тексты | T1 | builder (base) | 20 | 29.10 |
| 22 | e2e B7, C9, B9a, B9b; изоляция §8 | T1 | tester | 14–21 | 29.10 |
| 23 | ревью 11–21 (передача, слияние, снимки, утечка «номер есть в базе») | T2 | reviewer | 11–21 | 29.10 |
| 24 | T0: тексты, `NAMESPACES`, аудит, строки реестра воркера, проверка стоп-слов | T0 | mechanic | по мере влития | — |

Резка при отставании (D-058): к 26.10 не режутся пп. 1, 3–6 (пилот: «Отсутствует», «Пауза») и поля/правки
C8; из C8 первыми уходят в `0.9.1` история сделок, затем итоговый отчёт, затем заметки. После пилота —
список Б PLAN §6.3: слияние (п. 20–21) и массовая передача (флаг) уходят на неделю 2 раньше всего прочего.

---

## 13. Вопросы владельцу (до ответа действует рекомендация)

| № | Вопрос | Рекомендация |
|---|---|---|
| В-1 | Может ли оператор сам ставить себе «Пауза» (PROCESS 7.5 «если разрешено»)? | Нет к 01.11: пауза только РОП. После 01.11 — ключ `distribution.selfPause` (по умолчанию `false`) |
| В-2 | «Срочно» при отключении: вместо задачи на каждую карточку — одно уведомление «Разберите дела сотрудника: K» со списком полученных карточек (у задачи обязателен клиент) | Да, так |
| В-3 | Массовая передача «все клиенты А → Б»: передавать ли архив (закрытые карточки)? | По умолчанию только рабочие; архив — галочкой |
| В-4 | Отсутствие: показывать временному гостей с записью на следующий рабочий день после отсутствия (чтобы он сделал напоминание накануне)? | Да |
