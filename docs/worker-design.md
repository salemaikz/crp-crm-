# Воркер фоновых задач — дизайн P7 для builder

Статус: дизайн architect, 22.10.2026. Нормативно: ARCHITECTURE §6, D-018, решения **D-171, D-172**.
Контракт (типы и сигнатуры) уже в `src/server/platform/jobs/types.ts` — его не меняем без architect.
Перед кодом прочитай `docs/schema-v1.md` (job_runs, webhook_inbox, push_outbox) и `src/server/platform/db/`.
Все примеры — синтетика.

## 1. Файлы

| Файл | Что | Слой |
|---|---|---|
| `src/server/platform/jobs/types.ts` | контракт (готов) | платформа |
| `src/server/platform/jobs/slot.ts` | `slotFor` — чистая функция по `ScheduleSpec` и календарю | платформа |
| `src/server/platform/jobs/repo.ts` | SQL job_runs: захват слота, завершение, сироты, пульс, последние прогоны | платформа |
| `src/server/platform/jobs/queues.ts` | SQL и цикл очередей `webhook_inbox`, `push_outbox` (SKIP LOCKED, аренда, повторы) | платформа |
| `src/server/platform/jobs/runner.ts` | прогон одного экземпляра: блокировка → захват → таймаут → завершение | платформа |
| `src/server/platform/jobs/index.ts` | публичные экспорты | платформа |
| `src/server/platform/db/locks.ts` | + `tryAdvisoryLock(db, classId, key)` на выделенном соединении (`client.reserve()` postgres.js); перенос сюда `DISTRIBUTION_LOCK_KEY`, `SKIP_LOCK_CLASS`, `JOB_LOCK_CLASS` (значения те же) — **после** влития C5/C6a, отдельным коммитом | платформа |
| `src/server/jobs/registry.ts` | список `JobDefinition` и `QueueSpec` (сборка; здесь можно `systemActor()`) | jobs |
| `src/server/jobs/platform.ts` | задачи платформы: `purge` (части платформы), `invariants` (оболочка), `events-ensure`, заглушки `license`, `config-integrity` | jobs |
| `src/server/jobs/worker.ts` | главный цикл: старт, циклы 30 с и 5 с, пульс, остановка по SIGTERM | jobs |
| `scripts/worker/index.ts` | точка входа → `dist/worker.mjs` (Dockerfile уже собирает её, O1); флаг `--health` | scripts |
| `scripts/crmctl/job.ts` | `crmctl job run <имя> [--space <ключ>] [--slot <ключ>]`, `crmctl job list` (запуск до реестра: `tsx scripts/crmctl/job.ts`) | scripts |
| `messages/ru/jobs.json` | не нужен: воркер текстов пользователю не показывает | — |

`src/server/platform/**` не импортирует домен (ESLint). Поэтому платформа даёт механику, а задачи модулей
подключает `src/server/jobs/registry.ts`, который видит и платформу, и домен.

## 2. Расписание: `slotFor(spec, now, cal)`

Чистая функция, `now` и календарь — параметры. Местное время — `time.toLocalTime(now, cal.timezone)`,
начало слота — `time.fromLocalTime(day, hhmm, tz)`.

| Вид | Слот в момент `now` | Ключ |
|---|---|---|
| `daily {at, days}` | день подходит по `days` и местное время ≥ `at` → слот на весь остаток суток (простой догоняется в тот же день) | `2026-10-28` |
| `times {at[], days}` | последний наступивший момент из `at` сегодня | `2026-10-28T07:30` |
| `grid {from,to,everyMin,days,graceMin}` | последняя точка `from + k·everyMin ≤ min(now, to)`; если `now − точка > graceMin` → `null` (пропущенный тик не догоняется) | `2026-10-28T11:00` |
| `interval {everyMin}` | `floor(минуты от полуночи / everyMin) · everyMin` | `2026-10-28T14:05` |
| `manual` | всегда `null` | — |

Ручной запуск: `manual:<uuid>`; запуск при старте: `boot:<bootId>`. Ключ на минутах, а не на часах, как в
примере ARCHITECTURE §6.1 (`2026-10-28T11`), — потому что бывают шаги в 5 и 30 минут (D-171).

**Unit-тесты `tests/unit/platform/jobs-slot.test.ts`** (дважды: `TZ=UTC` и `TZ=Asia/Almaty`, календарь
тестовый — `packages/core/src/distribution/testCalendar.ts`):
- `daily 03:30`: 03:29 → null; 03:30 и 23:59 → `2026-10-28`; следующий день — новый ключ;
- `daily … workdays`: 26.10.2026 (перенесённый выходной) → null; суббота → null;
- `grid 08:00–18:00/60, grace 15`: 07:59 → null; 08:00:20 → `T08:00`; 11:14 → `T11:00`; 11:16 → null;
  18:05 → `T18:00`; 18:20 → null; праздник → null;
- `interval 5`: 14:07 → `T14:05`; полночь → `T00:00`;
- `times [07:30, 13:00]`: 07:00 → null; 12:59 → `T07:30`; 13:00 → `T13:00`;
- свойство: для любого `now` слот не позже `now`, ключ однозначно задаёт `slot.at`.

## 3. Прогон экземпляра (runner.ts)

Экземпляр = задача (или задача × пространство для `perSpace`): `runName` = `purge` или `distribute@sales`.
Строка `job_runs.job` = `runName`.

```
runInstance(inst, now):
  spec = inst.spec; slot = slotFor(spec, now, cal); если null → выход
  lock = tryAdvisoryLock(JOB_LOCK_CLASS, hashtext(runName))   -- выделенное соединение, сессионная
  если не взяли → выход (прогон идёт в другом процессе: старый воркер при выкладке, crmctl job run)
  try:
    claim = repo.claim(runName, slot.key, now, maxAttempts)      -- одна короткая транзакция, см. ниже
    если claim.kind ≠ 'claimed' → выход
    если def.writes = 'business' и лицензия блокирует → repo.finish(skipped, note 'license_read_only') → выход
    ctx = { actor: systemActor(runName, now), runId, slot, attempt, now, signal, space, calendar, log }
    result = await race(def.handler(ctx), таймаут timeoutMs)
    repo.finish(runId, result.status, result.stats, '')
  catch e:
    repo.finish(runId, 'failed', {}, код ошибки: e.code ?? e.name, без message с данными)
  finally:
    lock.release()   -- pg_advisory_unlock + вернуть соединение
```

**Захват слота** (`repo.claim`, одна транзакция; соединение — обычный пул):

```sql
-- 1. Сироты: под нашей блокировкой задачи никто другой её не выполняет, значит running — упавший процесс.
UPDATE job_runs SET status = 'failed', finished_at = $now, error = 'orphaned'
 WHERE job = $runName AND status = 'running';
-- 2. Новый слот
INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at)
VALUES ($newId, $runName, $slotKey, 'running', 1, $now)
ON CONFLICT (job, slot_key) DO NOTHING RETURNING id, attempt;
-- 3. Строка уже есть: повтор упавшего, если попытки остались и пауза прошла
UPDATE job_runs SET status = 'running', attempt = attempt + 1, started_at = $now, finished_at = NULL, error = ''
 WHERE job = $runName AND slot_key = $slotKey AND status = 'failed' AND attempt < $maxAttempts
   AND finished_at <= $now - (60000 * 2 ^ (attempt - 1))
RETURNING id, attempt;
```

`runId` = `job_runs.id` и при повторе тот же: на нём задачи строят свою идемпотентность (раздача — `run_id`
в `assign_log`, уведомления — `dedupe_key`).

**Таймаут.** `timeoutMs` (по умолчанию 5 мин; `distribute` — 2 мин). По таймауту: `signal.abort()`,
строка → `failed`, `error = 'timeout'`. Если обработчик не вернулся ещё через `JOB_HARD_KILL_GRACE_MS`
(30 с) — `process.exit(70)`: контейнер перезапустится (`restart: unless-stopped`), Postgres откатит открытые
транзакции и снимет сессионную блокировку, строка станет сиротой и повторится. Внутри своих транзакций
задачи ставят `SET LOCAL lock_timeout = '10s'` (не висеть на чужой блокировке).

**Лицензия.** Состояние — та же функция, что у обёрток (`src/server/access/license.ts`, P10). Импортирует
её `src/server/jobs/worker.ts`, не платформа. `read_only`, `invalid`, `missing` → задачи `business` и очередь
`push_outbox` пропускаются, `housekeeping` работает.

## 4. Главный цикл (src/server/jobs/worker.ts)

- Старт: `assertTimeZone` + проверка «Asia/Almaty = UTC+5» (PROCESS 12.34, как у приложения);
  `openScriptDb()` (только `assertMigrated`); `bootId = randomUUID()`. Нет настроек
  (`ConfigMissingError`) — лог раз в минуту и ждать, не падать.
- Цикл задач каждые `WORKER_TICK_MS` (30 с): `getActiveConfig()` → календарь из `global` →
  экземпляры реестра (perSpace × пространства) → `runInstance` по очереди (задачи короткие; параллелизм
  не нужен и усложняет нагрузку на БД). Задачи с `runOnStart` — один раз при старте со слотом `boot:<bootId>`.
- Цикл очередей каждые `WORKER_QUEUE_TICK_MS` (5 с): для каждой включённой `QueueSpec` — §5.
- Пульс в конце каждого цикла задач: `INSERT INTO job_runs (id, job, slot_key, status, attempt, started_at,
  finished_at, stats) VALUES (…, 'worker.heartbeat', '-', 'ok', 1, $startedAt, $now, $stats) ON CONFLICT
  (job, slot_key) DO UPDATE SET finished_at = EXCLUDED.finished_at, started_at = EXCLUDED.started_at,
  stats = EXCLUDED.stats` — одна строка на установку, не растёт; `stats` = числа `WorkerHeartbeat`
  (версию показывает `crmctl status` по образу). Затем `touch /tmp/crm-worker.alive`.
- SIGTERM/SIGINT: перестать брать новые экземпляры, `abort()` текущего, ждать до 20 с, снять блокировку,
  закрыть БД, `exit 0`.
- `dist/worker.mjs --health`: `exit 0`, если mtime `/tmp/crm-worker.alive` моложе 90 с, иначе `exit 1`.
  Это healthcheck контейнера (правка `deploy/compose/compose.yaml` — ops, §9). `crmctl status` видит
  здоровье воркера через `compose ps`; страница «Состояние» и сводка администратора читают
  `job_runs` (`worker.heartbeat` и последние прогоны) — R/admin позже.

## 5. Очереди inbox/outbox (queues.ts)

```sql
-- взять пачку (аренда), в одной транзакции
UPDATE webhook_inbox SET lease_until = $now + $leaseMs, attempts = attempts + 1
 WHERE id IN (SELECT id FROM webhook_inbox
               WHERE state = 'pending' AND next_at <= $now AND (lease_until IS NULL OR lease_until < $now)
               ORDER BY next_at, id LIMIT $batch FOR UPDATE SKIP LOCKED)
RETURNING id, integration_id, kind, attempts;
-- handlerKey = integrations.plugin_id (отдельный SELECT по id из пачки)
-- итог по строке
done   → state = 'done', processed_at = $now, lease_until = NULL, error = ''
retry  → next_at = $now + min(30000 · 2^(attempts−1), 3 600 000), lease_until = NULL, error = $code;
         attempts ≥ maxAttempts → state = 'failed'
failed → state = 'failed', lease_until = NULL, error = $code
```

`push_outbox` — то же (`state` `pending → sent|failed`, `sent_at`), `handlerKey = 'push'`.
Обработчиков сейчас нет: `webhook_inbox` — плагины O6 (ops, 27.10); `push_outbox` — P8b, очередь включена
только при `FEATURE_PUSH`. Нет обработчика → `retry` с `no_handler` (строки не теряются). `maxAttempts`:
вебхуки 8, push 5. Ошибки — коды без ПДн.

## 6. Реестр задач (ARCHITECTURE §6.2)

`schedule` берёт значения из настроек там, где они есть; остальное — константы продукта в реестре.

| Задача | perSpace | Расписание (`ScheduleSpec`) | writes | Кто реализует `handler` | Что делает P7 |
|---|---|---|---|---|---|
| `distribute` | да | `grid` из `distribution.schedule` (`workdaysOnly` → `workdays`), `graceMin` 15; `mode` `manual`/`off` → `null` | business | **C6a** `src/server/domain/distribution/job.ts` (возвраты — C6c, неделя 2) | строка в реестре после влития C6a (§9) |
| `absence` | да | `daily 07:30 all` + запуск из C6b при изменении отсутствия | business | C6b | — |
| `events-ensure` | нет | `daily 00:30 all` (ARCHITECTURE; booking-design §12 «03:00» — устарело) | business | готово: `ensureAllSeries(bookingDeps(), actor)` | **обёртка и регистрация** |
| `attendance-sweep` (автонеявка) | да | `daily 10:00 workdays` | business | B4b (`SweepAttendance`) | — |
| `grey-assign` («серые» БК) | да | `grid` из `booking.grey.schedule` (`first`, `last`, `stepMin`), `workdays`, grace 10 | business | B5 | — |
| `digest` | да | `daily notifications.morningDigestAt workdays`; `null` → выкл | business | P8a | — |
| `alarms` | да | `grid 09:00–18:00/60 workdays`, grace 15 | business | P8a | — |
| `callback-soon` | да | `interval 5`; `notifications.callbackSoonMinutes = null` → выкл | business | P8b (неделя 2) | — |
| `invariants` | нет | `daily 02:40 all` | housekeeping | части: C5 `countOwnerlessWorkingCards` (D-066), B4b «`agreed` без шага» (D-049) | **оболочка**: сумма частей в `stats`, по ключу на часть |
| `purge` | нет | `daily 03:30 all` | housekeeping | части модулей (§7) | **оболочка + части платформы** |
| `counters-reconcile` | нет | `daily 02:30 all` | housekeeping | calling, неделя 2 | — |
| `config-integrity` | нет | `daily 02:45 all` | housekeeping | платформа, позже | заглушка `skipped`/`not_implemented` |
| `license` | нет | `interval 60` + `runOnStart` | housekeeping | P10 | заглушка `skipped`/`not_implemented` |
| `telephony-reconcile` | да | `daily 02:00`, только при включённом провайдере | business | ops, после 1.11 | не регистрируется |

Не реализованная задача **не регистрируется** (а не висит заглушкой со слотами), кроме `license` и
`config-integrity`: у них заглушка, чтобы страница «Состояние» показывала «не реализовано».

## 7. `purge` — части

| Часть | SQL (где) | Кто |
|---|---|---|
| сессии: `expires_at < now` | `DELETE FROM sessions …` (platform/auth) | P7 |
| приглашения: `expires_at < now − 30 дн` | `DELETE FROM invites …` (platform/auth) | P7 |
| push: `state IN ('sent','failed','cancelled') AND created_at < now − 30 дн` | queues.ts | P7 |
| устройства: `seen_at < now − 30 дн` | `DELETE FROM device_status …` — домен calls, функция `purgeDeviceStatus(actor, before)` | C5 (подключение — §9) |
| `import_rows` старше 14 дней | домен import | base (C4) |
| `ingest_batches` старше 30 дней | домен intake | base |
| `change_snapshots` старше 30 дней | clients/team | B9 |
| `webhook_inbox.payload = NULL` старше 14 дней | ops (`src/integrations`) | O6 |

Каждая часть — `(actor: SystemActor, before: number) => Promise<number>`; удаления пачками по 5 000 строк
до нуля, проверка `signal` между пачками. `job_runs` не чистится: у `crm_app` нет DELETE, рост ≈ 30 строк в
день.

## 8. Тесты

**Unit:** `slot` (§2); `runner` с поддельными repo и часами: таймаут → `failed timeout`, `signal` сработал;
`business` при `read_only` → `skipped`; ошибка → код без текста; `registry`: имена уникальны, у каждой
задачи `schedule` на пресете `base` и накладке ЦРП (`presets/**`) даёт допустимый `ScheduleSpec`.

**Интеграционные** (`tests/integration/platform/jobs-*.test.ts`, Postgres 16):
- двойной запуск: два `runInstance` одного экземпляра параллельно (две «копии воркера», разные соединения) →
  обработчик вызван один раз, одна строка `job_runs`;
- тот же слот после `ok` → обработчик не вызывается; новый слот → вызывается;
- упал → `failed attempt 1`; до паузы не повторяется; после паузы → `attempt 2` с тем же `runId`; после
  `maxAttempts` — больше нет;
- сирота: строка `running` без блокировки → при следующем захвате `failed orphaned` → повтор;
- блокировку держит другое соединение (имитация `crmctl job run`) → прогон пропущен без записи;
- убитый процесс: соединение с блокировкой закрыто → блокировка снята (повторный захват удаётся);
- очередь: 30 строк, два параллельных прохода → каждая строка обработана один раз; `retry` → `next_at`
  растёт, после `maxAttempts` → `failed`; нет обработчика → `no_handler`;
- пульс: 3 цикла → одна строка `worker.heartbeat`, `finished_at` растёт;
- `purge` платформы: просроченные сессии удалены, живые нет; пачки.

**Изоляция:** новых маршрутов нет. Статический тест слоёв зелёный: `systemActor` только в
`src/server/jobs/**` и `scripts/**`.

## 9. Нужно от других и после влития

| Что | Кто | Когда |
|---|---|---|
| строки в `src/server/jobs/registry.ts`: `distributeJob` (C6a), `countOwnerlessWorkingCards` в `invariants` и `purgeDeviceStatus` в `purge` (C5) | координатор (T0 `mechanic`) | при влитии C6a/C5 после P7 |
| перенос ключей блокировок в `src/server/platform/db/locks.ts` + `tests/unit/platform-lock-keys.test.ts` (все ключи и классы различны) | platform | после влития C5 и C6a |
| healthcheck воркера в `deploy/compose/compose.yaml`: `["CMD", "node", "dist/worker.mjs", "--health"]` | ops (issue) | 23.10 |
| `crmctl job` в реестре `scripts/crmctl/index.ts` | ops (одна строка) | 23.10 |
| `crmctl config apply` → запуск `events-ensure` после применения | platform/ops | 24.10 |

## 10. Чего builder P7 НЕ делает

Не пишет обработчики задач модулей (раздача, отсутствие, неявка, «серые», сводка, тревоги), отправку push
и разбор вебхуков; не меняет схему (миграция не нужна: сироты определяются блокировкой, пульс — строкой
`job_runs`); не делает страницу «Состояние»; не трогает `deploy/**`, `Dockerfile`, `scripts/crmctl/index.ts`.
