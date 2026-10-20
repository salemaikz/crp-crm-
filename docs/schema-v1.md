# Схема БД v1 — карта таблиц для builder

Описательный документ. Источник правды — `migrations/2026-10-21-platform-schema-v1.sql`;
при расхождении правится этот файл. Решения — D-067…D-070, модель — `docs/ARCHITECTURE.md` §4.

## Правила, которые нужно знать до первого запроса

- id `TEXT` (UUID из приложения), время `BIGINT` epoch-мс, деньги `BIGINT` в целых тенге,
  местные дата и время — `TEXT 'YYYY-MM-DD'` / `'HH:MM'` (формат проверяет `CHECK`).
- SQL — только в `src/server/domain/*/repo.ts`, охват `scopeSql` в каждом SELECT и UPDATE.
- **FK на все ссылки** (D-067). Исключения: `audit_log`, полиморфные `ref_id`/`entity_id`/`row_id`/`run_id`,
  `calls.telephony_call_id`. В тестах вставляйте родителей раньше детей.
- **Автор-система — `NULL`** (D-067): колонки автора действия (`created_by`, `*_by`, `actor_id`, `author_id`,
  `calls.user_id`, `bookings.booked_by_user_id`) допускают `NULL` для системы, CLI, импорта и воркера; выдуманного
  автора не подставлять. Звонок без автора — только при `via` `import`/`telephony` (`calls_user_id_check`).
  `NOT NULL` — у субъекта строки (сессия, членство, получатель уведомления) и у `skips`, `proposals`, `phone_probes`.
- **Ничего не удаляется**: сотрудники — `status='disabled'`, клиенты — `merged_into_id`, ключи настроек —
  архив. У `crm_app` `DELETE` есть **только** у служебных таблиц (явный список в `deploy/postgres/grants.sql`):
  `sessions`, `invites`, `push_subscriptions`, `push_outbox`, `device_status`, `import_rows`, `ingest_batches`,
  `change_snapshots` (purge), `client_phones` (удалить номер, дубль номера при слиянии), `stop_list` (снятие
  «Не звонить», PROCESS 3.5 № 15), `resource_schedule`, `resource_exceptions`, `event_duty` (сменяемые окна и
  дежурства), `integration_secrets`. На остальные таблицы `DELETE` отклоняет БД; новой таблице из будущей
  миграции он тоже не выдаётся — нужен, значит architect добавляет её в список. Карточка слитого клиента не
  удаляется: на неё ссылаются звонки.
- **Только добавление** (права БД, D-068): `audit_log`, `client_events`, `booking_history`, `consents`,
  `config_revisions` — без `UPDATE` и `DELETE`. Лента слитого клиента читается по цепочке `merged_into_id`.
- **`audit_log.meta` — без значений ПДн**: только id, коды и числа. Журнал выгрузок пишет вид выгрузки, коды полей
  фильтра и число строк, но не текст поиска, номер или имя (журнал не чистится обезличиванием).
- **Идемпотентность — уникальными индексами**, повтор = `INSERT … ON CONFLICT DO NOTHING` и чтение прежнего:
  `calls.id`/`skips.id`/`proposals.id` = opId; `calls.import_key`, `bookings.import_key`; `deals.request_id`,
  `bookings.request_id`; `tasks.source_key` (только среди открытых: `ON CONFLICT (source_key) WHERE source_key IS NOT
  NULL AND status = 'open' DO NOTHING`; закрытая задача ключ не держит); `handoffs.deal_id`; `ingest_batches (source_key, batch_id)`;
  `client_sources (source_key, external_id)`; `webhook_inbox (integration_id, dedupe_key)`;
  `job_runs (job, slot_key)`; `notifications.dedupe_key`; `push_outbox (notification_id, subscription_id)`;
  `events.occurrence_key`; `bookings_group_uq` (одна активная запись клиента на мероприятие).
- Закрытые списки — именованные `CHECK` `<таблица>_<колонка>_check`. Новое значение = новая миграция
  (architect), не правка v1 (D-059).
- Колонки с ПДн помечены `-- pii` и стоят в реестре ARCHITECTURE §4.6; `tests/unit/static-pii-registry.test.ts`
  сверяет пометки и реестр в обе стороны. Новая колонка с ПДн — только через architect и реестр. Строки реестра
  для таблиц телефонии (их ещё нет) статический тест пропускает.
- HMAC и хэши — 64 hex-символа (`CHECK`): открытый номер или ИИН в `stop_list`/`iin_hmac` не запишется.
- Нужен `pg_trgm` (ставит сама миграция в схему `public`; доверенное расширение — владелец БД ставит его без
  суперпользователя). Тесты идут на Postgres 16 из `TEST_DATABASE_URL`, каждый файл — во временной схеме.
- `schema_migrations (name TEXT PK, sha256 TEXT NOT NULL, applied_at BIGINT NOT NULL)` создаёт раннер
  `migrate` (P1), не файл схемы. Права `crm_app` — `deploy/postgres/grants.sql` после каждого migrate; схему
  дважды, `grants.sql` дважды и права `crm_app` проверяет `tests/integration/schema/schema-v1.test.ts`.

## Таблицы

«Кто пишет» — модуль (`src/server/domain/<модуль>`) или процесс; поток — по PLAN §2.

### Платформа

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `users` | сотрудники установки | `phone_digits` UNIQUE, `password_hash`, `is_admin`, `status` | auth, team; `crmctl install` (первый админ) |
| `sessions` | сессии cookie | `id` = sha256 токена, `expires_at` | auth; purge |
| `spaces` | пространства (отделы) | `key` UNIQUE, один `is_default` | `crmctl config apply` |
| `teams` | команды и отделы для передач | `(space_id, key)` UNIQUE, `lead_user_id` | config apply; admin |
| `invites` | приглашения и сброс пароля | `token_hash` UNIQUE, `kind`, `space_id`+`role_key` вместе или пусты | auth, team; purge |
| `memberships` | роль сотрудника в пространстве | PK `(user_id, space_id)`, `role_key`, `in_distribution`, `paused_on` | team, distribution («Пауза») |
| `absences` | «Отсутствует» по датам | `from_day`…`to_day`, `substitute_user_id` | distribution; job `absence` |
| `config_revisions` | ревизии ConfigV1 | `(scope, rev)` UNIQUE, `schema_version`, `doc`, `source`; только добавление | platform/config, `crmctl config` |
| `job_runs` | прогоны фоновых задач | `(job, slot_key)` UNIQUE, `status`, `attempt` | воркер (platform/jobs) |
| `notifications` | колокол | `user_id`, `kind`, `params` (без ПДн), `dedupe_key` UNIQUE | notify (любой модуль через notify) |
| `push_subscriptions` | подписки web-push | `endpoint` UNIQUE, `device_id` | notify |
| `push_outbox` | очередь push | `(notification_id, subscription_id)` UNIQUE, `state`, `next_at`, `lease_until` | notify; воркер |
| `license_state` | состояние лицензии, одна строка | `state`, `last_seen_at`, `install_id` | platform/license; job `license` |
| `audit_log` | аудит, журнал выгрузок | `action`, `entity`, `entity_id`, `space_id`, `meta`; без FK, только добавление | platform/audit из всех модулей |
| `device_status` | неотправленные итоги устройств (D-063) | PK `(user_id, device_id)`, `pending_outbox` | `/api/device` (platform) |
| `phone_probes` | счётчик проверок номера (D-040) | `(user_id, day)`, `path`, `matched`; номера нет | intake, clients, booking (гость) |

### Клиенты и приём

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `clients` | клиент, общий на установку | `org_id` UNIQUE*, `iin_hmac` UNIQUE*, `name_norm`, `search_norm` (trgm), `custom`, `merged_into_id` | clients, intake, import |
| `contacts` | контактные лица | `client_id`, `is_decision_maker`, `custom` | clients |
| `client_phones` | номера клиента | `(client_id, digits)` UNIQUE, один `is_primary`, `is_working`, `kind` | clients, intake, import |
| `stop_list` | «Не звонить» навсегда | PK `phone_hmac` | cards (итог), clients (обезличивание), import |
| `client_sources` | откуда пришёл клиент | `(source_key, external_id)` UNIQUE*, `ingest_key_id`, `import_id` | intake, import |
| `dup_pairs` | спорные пары | `a < b`, `(a, b, reason)` UNIQUE, `status` | intake, import (создают); distribution/pairs (решает РОП) |
| `consents` | согласия клиента | `kind`, `action` given/revoked, `text_hash`; только добавление | clients, messenger |
| `change_snapshots` | снимки «до» слияния и массовой передачи | `operation_id`, `client_id`, `before` | clients/merge, team/transfer; purge |
| `imports` | загрузки таблиц | `file_sha256`, `profile_key`, `status`, `report` (счётчики) | import |
| `import_rows` | строки предпросмотра (14 дней) | `(import_id, row_no)` UNIQUE, `import_key`, `parsed` | import; purge |
| `ingest_keys` | ключи API приёма | `prefix` UNIQUE, `key_hash`, `source_key`, `scopes`, `managed` | `crmctl ingest-key` (intake) |
| `ingest_batches` | партии приёма (30 дней) | `(source_key, batch_id)` UNIQUE, `request_hash`, `report` | intake; purge |
| `proposals` | «Предложить контакт» | `id` = opId, `status`, `matched_client_id`, `client_id` | intake |

\* частичный индекс: только для не слитых клиентов / непустых значений.

### Обзвон

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `cards` | работа отдела с клиентом, 9 состояний | `(space_id, client_id)` UNIQUE, `owner_user_id`/`acting_user_id`, `state`, `hold_reason`, `next_call_at`, `return_at`, счётчики, `version` | cards, calls, distribution, intake, import |
| `calls` | звонки и итоги | `id` = opId, `outcome_kind` (7 видов), `applied`/`fact_reason`, `occurred_at`, `import_key` UNIQUE* | calls, import |
| `assign_log` | журнал раздачи, лимит дня | `kind`, `counts_to_cap`, `day`, `to_user_id` | distribution, team (передача), intake, import |
| `skips` | пропуски | `id` = opId, `(user_id, day)` | calls |

### Запись

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `event_series` | серии групповых мероприятий | `weekday` 1–7, `start_time`, `capacity`, `active` | booking (РОП); config apply (`seedSeries`) |
| `events` | конкретные мероприятия | `occurrence_key` UNIQUE*, `starts_at`, `capacity`, `status`, `touched` | booking; job `events-ensure` |
| `event_duty` | дежурные мероприятия | PK `(event_id, user_id)` | booking |
| `resources` | консультанты | `(space_id, user_id)` UNIQUE, `directions`, `slot_min`, `capacity`, `active` | booking |
| `resource_schedule` | недельный график (окна) | `resource_id`, `weekday`, `start_time` < `end_time` | booking |
| `resource_exceptions` | исключения по датам | `(resource_id, day)` UNIQUE, `kind` off/custom, `windows` | booking |
| `bookings` | записи (6 статусов) | `kind`, `event_id`/`resource_id`, `status`, `booked_by_user_id`, `responsible_user_id`, `moved_from/to`, `request_id`/`import_key` UNIQUE*, `via` | booking, calls (мастер «Договорились»), import (профиль «Записи»); job `grey-assign`, `attendance-sweep` |
| `booking_history` | история статусов записи; только добавление | `booking_id`, `action`, `from_status`, `to_status` | booking |

### Сделки, задачи, лента

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `deals` | сделки и покупки | `pipeline_key`, `stage_key`, `status`, `amount_kzt` ≥ 0, `won_at`, `request_id` UNIQUE*, `version` | deals, calls (мастер), booking (явка двигает этап) |
| `handoffs` | передачи в отдел | `deal_id` UNIQUE, `team_id`, `status`, `due_at` | handoffs (создаёт deals при покупке) |
| `tasks` | задачи | `source` (закрытый список), `source_key` UNIQUE среди открытых, `assignee_user_id`, `status`, `due_at` | tasks; `tasks/auto.ts` (calling) и все модули через него; jobs |
| `task_comments` | комментарии к задачам | `task_id`, `author_id`, `body` | tasks |
| `notes` | заметки по клиенту | `client_id`, `space_id`, `deal_id`, `pinned` | timeline/clients |
| `client_events` | лента клиента; только добавление | `client_id`, `space_id`, `deal_id`, `kind`, `at`, `data` | каждый модуль в своей транзакции |

### Интеграции

| Таблица | Назначение | Ключевые поля | Кто пишет |
|---|---|---|---|
| `integrations` | подключённые плагины | `plugin_id`, `space_id` (NULL = установка), `enabled`, `webhook_token_hash` UNIQUE, `crossborder_approved_at` | admin (ops: `src/integrations`) |
| `integration_secrets` | секреты AES-256-GCM | PK `(integration_id, name)`, `kid`, `iv`, `ciphertext`, `tag` | platform/secrets; `crmctl secrets rotate` |
| `webhook_inbox` | входящие вебхуки | `(integration_id, dedupe_key)` UNIQUE, `state`, `next_at`, `payload` (14 дней) | `/api/hooks` (ops); воркер; purge |
| `messenger_channels` | каналы Wazzup | `(integration_id, provider_channel_id)` UNIQUE, `owner_user_id` | messenger.wazzup (ops) |
| `messenger_chats` | чаты с клиентами | `(channel_id, chat_type, chat_id)` UNIQUE, `client_id`, `awaiting_reply` | messenger.wazzup (воркер) |
| `messenger_messages` | сообщения | `(integration_id, provider_message_id)` UNIQUE, `direction`, `body` | messenger.wazzup (воркер) |

Не в v1 (D-069): `telephony_endpoints`, `call_intents`, `telephony_calls`, `call_recordings` — с первым
живым адаптером; функция `depersonalize_client(id)` — с B9.
