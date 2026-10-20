# Спецификация машины состояний карточки обзвона (K1d)

Исполняемая спецификация для `applyOutcome`. Строки таблицы переходов
`docs/PROCESS.md` §3.5 (№ 1–31) и граничные случаи §12 записаны здесь как
тест-векторы. Реализация считается верной, когда проходит все векторы.

| Файл | Что в нём |
|---|---|
| `types.ts` | вход `TransitionInput`, результат `TransitionResult`, побочные эффекты `Effects`, константы-данные (`OUTCOME_ALLOWED_FROM`, `CALLBACK_TASK_SOURCES` …) |
| `vectors.ts` | `VECTORS: TransitionVector[]`, тестовый календарь `TEST_CALENDAR` (UTC+5, пн–пт, 26.10.2026 выходной, окно [09:00, 18:00)), тестовые настройки `TEST_SETTINGS`, помощник `at('YYYY-MM-DD HH:MM')` |

Реализацию builder кладёт в `packages/core/src/calling/applyOutcome.ts` с
сигнатурой `ApplyOutcome` из `types.ts`. Файлы `spec/` не правятся ради
зелёного прогона: если вектор кажется неверным, это вопрос к architect
(issue с меткой `stream:calling`).

## Тест

`tests/unit/calling/apply-outcome-vectors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VECTORS } from '../../../packages/core/src/calling/spec/vectors';
import { applyOutcome } from '../../../packages/core/src/calling/applyOutcome';

for (const v of VECTORS) {
  test(`${v.id} · ${v.title} (${v.refs.join(', ')})`, () => {
    const before = structuredClone({ card: v.input.card, event: v.input.event });
    assert.deepStrictEqual(applyOutcome(v.input), v.expected);
    // вход не мутируется
    assert.deepStrictEqual({ card: v.input.card, event: v.input.event }, before);
  });
}

test('id векторов уникальны', () => {
  assert.equal(new Set(VECTORS.map((v) => v.id)).size, VECTORS.length);
});
```

Дополнительно к векторам builder пишет свойства (`node:test`, без
библиотек): для любого итога из рабочего состояния `version` растёт ровно на
1; `nextCallAt !== null` только в `retry` и `callback`; `returnAt !== null`
только в `not_interested`.

## Контракт функции

- Чистая: без БД, сети, `Date.now()`, случайных id. Всё приходит во входе,
  всё, что нужно записать, уходит в результате. Вход не мутируется.
- В `Effects` присутствуют **все** массивы, даже пустые. Порядок элементов
  важен (векторы сравниваются глубоко): задачи — сначала закрытия, потом
  создания; лента — сначала `call` или `card.state`, затем события номеров и
  стоп-листа; номера для стоп-листа — в порядке «номер разговора, затем
  отмеченные».
- `card.version` растёт на 1, если изменилось хоть одно поле карточки
  (включая счётчики у `fact_only`). Если не изменилось ничего (пропуск,
  «Пришёл», сверки, «Не пришёл» при другой будущей записи), карточка
  возвращается как была, с той же версией.
- `touchedInCrm = true` после любого итога или ручного действия с состоянием
  карточки в CRM. Не ставят его импорт (`import_agreed`) и смена владельца без
  итога: раздача, возврат в пул, передача, замещение (D-145) — иначе ночная
  дозагрузка таблиц давала бы «оставлено как в CRM» по карточке, которую
  никто не звонил (PROCESS 12.14).
- Получатель `{ role: 'lead' }` — сотрудники с охватом `space` по задачам
  пространства; если у карточки нет владельца, задачи владельцу уходят им же.

## Итог звонка (`type: 'outcome'`): порядок проверок

1. `facts.sameOpId` есть → `duplicate` с прежним результатом (12.2). Слой БД
   может отсечь повтор раньше, но функция обязана вести себя так же.
2. Нет карточки → `not_found`.
3. Нет итога с `outcomeKey` → `outcome_unknown`.
4. `t` = `occurredAt`, ограниченное окном
   `[receivedAt − offlineWindowHours, receivedAt + 5 мин]`; если ограничили —
   предупреждение `occurred_at_clamped` (12.3). Дальше везде время звонка — `t`.
5. Итог архивный и `receivedAt > archivedAt + offlineWindowHours` →
   `outcome_archived` (12.31).
6. Действующий — система или охват `relation` → `forbidden`. Охват `own` и он
   не владелец и не временный владелец: если `facts.actorWasOwnerAtCall` —
   дальше как факт `owner_changed`, иначе `not_found` (8.3, 12.5).
7. Проверки полей (поле ошибки — в `field`): `reasonCode` (`requires.reason`);
   `lpr` (`requires.lpr` или `lprRequiredOnContact` для видов
   `LPR_ON_CONTACT_KINDS`); `lprInfo` («ЛПР: нет», `lprNoRequiresInfo`, нет ни
   данных ЛПР, ни заметки); `callbackAt` (обязателен для `callback`; раньше
   `t − callbackPastToleranceMin` → `callback_in_past`, 12.9); `agreement`,
   `agreement.contactId`, запись или дата (`agreed`); `phoneId` (`bad_number`,
   номер должен быть у карточки). Поля из `requires.fields[]` (ниша) проверяет
   движок полей K2 до вызова.
8. `owner_changed` → `fact_only`.
9. `card.lastOutcomeAt !== null && t <= card.lastOutcomeAt` → `fact_only`,
   `stale` (12.1).
10. Состояние не входит в `OUTCOME_ALLOWED_FROM[kind]` → `fact_only`, `stale`
    (12.4: звонок — факт, его нельзя потерять).
11. Применить.

**`fact_only`**: состояние, попытки, сроки и `lastOutcome*` не меняются;
счётчики звонков обновляются (как у применённого), `version + 1`. Лента —
событие `call` с `fromState = toState` и `factReason`. Задача: вид
`do_not_call` → руководителю `review:<opId>` (просьбу не звонить нельзя
потерять); иначе при `owner_changed` → текущему владельцу `review:<opId>`;
при `stale` прочих видов задач нет. `ownerUserIdAtCall` = действующий при
`owner_changed`, иначе текущий владелец.

**Счётчики** при любом звонке: `callsTotal + 1`; дозвон (`CONNECTED_KINDS`) —
`connectsTotal + 1`, `firstConnectAt = min`, `lastConnectAt = max`;
`no_answer` — `noAnswerTotal + 1`; `lastTouchAt = max(lastTouchAt, t)`.

**Применение** (`lastOutcomeCode/Kind/At = key/kind/t`; `lpr` берётся из итога,
если не пустой; чип `markTarget` ставит `isTarget = 'yes'`):

| Вид | Новое состояние и поля | Эффекты |
|---|---|---|
| `no_answer` | `k = attempts + 1`; `k ≥ maxAttempts` → `written_off`, `closeReasonCode = 'no_answer_limit'`, `closedAt = t`; иначе `retry`, `nextCallAt` = шаг `retry.steps[k − 1]` от `t` | — |
| `bad_number` | номер → `isWorking = false, isPrimary = false`; первый в порядке `phones` рабочий не из стоп-листа становится основным; есть такой → `retry`, `nextCallAt = t`, попытки не меняются; нет → `written_off`, `'no_working_phone'` | лента `phone.not_working`, `phone.primary` (если основной сменился) |
| `callback` | `callback`, `attempts = 0`, `nextCallAt = callbackAt`; вне окна звонков — предупреждение `callback_outside_work_hours`, срок **не сдвигается** (12.10) | задача `callback:<opId>` на `callbackAt` |
| `agreed` | `agreed`, `attempts = 0`, `isTarget = 'yes'` | сделка `ensure_open`; договорённость с датой без записи → задача `agreement:<opId>` |
| `not_interested` | `attempts = 0`, `returnAt = addDays(t, returnDays.not_interested)` или null, `closeReasonCode`, `closedAt = t` | сделки `lose_open` |
| `not_target` | `attempts = 0`, `isTarget = 'no'`, причина, `closedAt` | сделки `lose_open`, записи `cancel_future` |
| `do_not_call` | `attempts = 0`, причина, `closedAt`; номер разговора и `alsoDncPhoneIds` → `inStopList = true`, кроме общих с другим клиентом | стоп-лист `add`; общий номер → задача руководителю `dnc_confirm:<opId>:<phoneId>`; сделки `lose_open`; записи `cancel_future`; лента `dnc.set` |

**Шаги** (`retry.steps`, `noShowCallbackAt`, `nextStepTaskAt`): `+Nh`, `+Nm` —
сдвиг; `nextWorkday@HH:MM` — `calendar.nextWorkdayAt`. Только для шагов
повтора: если сдвиг попал вне окна звонков рабочего дня, срок =
`calendar.nextWorkdayTimeAfter(сдвиг, HH:MM)`, где `HH:MM` — время первого
шага `nextWorkday@…` в `retry.steps`, а если такого нет — `callWindowStart`
(PROCESS 3.4).

## Задачи и закрытые состояния (общие правила)

- Переход **в закрытое** состояние (`not_interested`, `not_target`,
  `do_not_call`, `written_off`) закрывает все открытые задачи клиента:
  `{ op: 'close', sources: 'all' }`.
- Иначе выход **из `callback`** закрывает задачу-проекцию:
  `{ op: 'close', sources: CALLBACK_TASK_SOURCES }` (D-050). Перенос
  перезвона (`callback → callback`) — закрыть и создать новую.
- Вход **в `callback`** создаёт ровно одну задачу-проекцию на срок
  `nextCallAt`: `callback:<opId>` (итог, возврат, «Вернуть в обзвон», снятие
  запрета, «Вернуть в работу», отмена покупки, ошибочная запись 12.7),
  `no_show:<bookingId>` (№ 16, 28), `rebook:<bookingId>` (№ 17),
  `clarify_import:<opId>` (№ 30). Исключение — слияние: задачи переезжают с
  клиентом.

## Остальные события

Общий порядок: нет карточки → `not_found`; событие только для системы
(`return_due`, `attendance_sweep`, `agreed_sweep`, `import_agreed`,
`inbound_message`) от пользователя → `forbidden`; охват `own` и не владелец
(`skip`, `inbound_reactivate`, `booking_cancelled`) → `not_found`;
`seenVersion` задан и не равен `card.version` → `version_conflict`; состояние
не подходит → `invalid_transition`; затем проверки полей и лимитов.

| Событие | № | Откуда | Результат |
|---|---|---|---|
| `enter` | 1 | нет карточки | `new` без владельца, счётчики 0, `version = 0`, лента `card.created` |
| `assign` | 2 | `new` без владельца, без задержки | владелец, `assignedAt = now`; `capRemaining ≤ 0` → `cap_exhausted`; журнал выдачи (`countsToCap` по `capIncludes`), сводное уведомление `assign:<runId>:<user>` |
| `release` | 3 | `new`, владелец есть, звонков 0 | без владельца; журнал `release`, лимит не возвращается |
| `close_from_menu` | 11, 12 | как у итога того же вида | как итог, но без звонка, счётчиков и `lastOutcome*`; `closedAt = now`; без отмеченных номеров «Не звонить» ставит основной |
| `return_due` | 13 | `not_interested`, `returnAt ≤ now` | владелец уволен → `new` в пул; лимит 0 → `cap_exhausted` (ждёт следующего дня); иначе `callback` сейчас, `attempts = 0`, `assignedAt = now`, журнал `return`, уведомление `return:<runId>:<user>` |
| `reopen` | 14 | `not_target`, `written_off`, `not_interested` | `callback` сейчас, `attempts = 0`; из `not_target` — `isTarget = ''`; нужен комментарий |
| `dnc_clear` | 15 | `do_not_call` | `callback` сейчас; из стоп-листа удаляются номера, которые не держит другой клиент; аудит |
| `no_show` | 16 | `agreed` | есть другая будущая запись → без изменений; иначе `callback` на шаг `noShowCallbackAt`, задача, значок сделки, уведомление |
| `attendance_sweep` | 28 | `agreed` | прошло 0 рабочих дней → ничего; меньше `autoNoShowWorkdays` (или выключено) → задачи «Отметьте явку» отмечающему и руководителю; иначе закрыть их и как № 16 |
| `booking_cancelled` | 17, 12.7 | `agreed` | `callback` сейчас с задачей `rebook`; «ошибка оператора» → сделка `lose_created_by`, задача `callback` |
| `attended` | 18 | `agreed` | до суток мероприятия → `too_early`; сделка `advance`; нет следующей записи → задача `next_step:<bookingId>` |
| `purchase` | 19 | `agreed`, `callback`, `client` | `client`; сумма — целое ≥ 0; сделка `win` |
| `purchase_cancelled` | 20 | `client` | есть открытая сделка → `agreed`, иначе `callback` сейчас |
| `deal_lost` | 21 | `agreed` | другая открытая сделка → без изменений; мягкая причина → `not_interested` с возвратом `deal_lost_soft`; жёсткая → `not_target` |
| `transfer` | 22 | любое | новый владелец, временный снят; задачи, открытые сделки, будущие записи — ему |
| `absence` | 23 | `retry`, `callback`, `agreed`, `client`; нетронутая `new` | временный владелец; нетронутая новая — в пул (как № 3) |
| `merge` | 24 | любое | правило 12.20, см. ниже |
| `skip` | 25 | рабочие | `skipsToday ≥ skipLimit` → `skip_limit`; запись пропуска за местные сутки |
| `inbound_message` | 27 | любое | состояние не меняется; `do_not_call` → задача руководителю `dnc_inbound`; иначе владельцу «Ответить» через `inboundReplyMinutes` (`missed_call` для звонка) |
| `inbound_reactivate` | 27 | `not_interested`, `written_off` | `callback` сейчас, `attempts = 0` |
| `agreed_sweep` | 29 | `agreed` | нет записи и задачи → задача `next_step:sweep:<cardId>:<день>` на шаг `nextStepTaskAt` |
| `import_agreed` | 30, 12.39 | `touchedInCrm = false` (иначе `touched_in_crm`) | звонок `via: 'import'`; запись найдена → `agreed`; нет → `callback` сейчас и задача `clarify_import` |
| `attendance_corrected` | 31 | `callback` | итог позже отметки «Не пришёл» → `stale`; иначе `agreed`, сделка `advance`, значок снят, нет следующей записи → `next_step` |

**Слияние** (`card` во входе остаётся, `event.other` уходит). Донор состояния:
`do_not_call` побеждает (если у обеих — остающаяся), иначе карточка с более
поздним `lastOutcomeAt` (null — самый ранний, равенство — остающаяся). От
донора: `state, holdReason, attempts, nextCallAt, returnAt, lpr, isTarget,
lastOutcome*, closeReasonCode, closedAt`. Владелец (`ownerUserId,
actingUserId, actingUntilDay, assignedAt`) — от донора при `ownerFrom: 'auto'`,
иначе от выбранной. Счётчики суммируются, `first*` — минимум, `last*` —
максимум, `touchedInCrm` — «или». Номера другой карточки добавляются в конец,
`isPrimary = false`. Смена владельца → переназначение задач, сделок, записей,
журнал `merge`, уведомление `card_merged` каждому потерявшему. Переход
остающейся карточки в закрытое состояние даёт те же закрывающие эффекты, что
итог этого вида.

## Чего функция не делает

Права «ресурс, действие» (обёртки `action()`), выбор карточек для раздачи,
«пара не делится», подсчёт лимита по журналу, поиск записей и сделок, текст
уведомлений и push, проверка полей по справочнику (K2), статусы записей. Всё
это приходит готовыми фактами (`facts`) или делается слоем домена по
эффектам.

## Как добавить вектор

Новый случай — новый вектор с уникальным `id` (`r<№><буква>` для строк 3.5,
`e<раздел 12>` для граничных) и ссылкой в `refs`. Если случай меняет правило,
сначала правится `docs/PROCESS.md`, затем вектор, затем реализация.
