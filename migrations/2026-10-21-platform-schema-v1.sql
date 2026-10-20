-- Схема БД v1 CRM отдела продаж — целиком, одним файлом (PLAN P2).
-- Нормативно: docs/ARCHITECTURE.md §4 (эскиз §4.3, таблицы §4.4, гарантии §4.5, реестр ПДн §4.6),
-- docs/CONFIG.md §2, docs/INTEGRATIONS.md §1, §3.2, §4, §5, docs/PROCESS.md §3, §5.3;
-- уточнения эскиза — D-067…D-070. Карта таблиц для builder — docs/schema-v1.md.
--
-- Правила файла:
-- - id TEXT (UUID выдаёт приложение), время BIGINT epoch-мс, деньги BIGINT в целых тенге (amount_kzt),
--   местные дата и время — TEXT 'YYYY-MM-DD' и 'HH:MM' плюс starts_at.
-- - Идемпотентно и только добавляет: повторный прогон ничего не меняет. После влития файл не правится
--   никогда (D-059): любая правка схемы — новый файл migrations/YYYY-MM-DD-<поток>-fix-<slug>.sql.
-- - Закрытые списки поведения — именованные CHECK (<таблица>_<колонка>_check): расширение списка —
--   DROP/ADD того же имени в новом файле (добавляющая правка). Ключи из настроек — TEXT без CHECK.
-- - Колонки с ПДн помечены «-- pii» и стоят в реестре ARCHITECTURE §4.6 (статический тест сверяет).
-- - Автор действия (created_by, *_by, actor_id, author_id, calls.user_id, bookings.booked_by_user_id)
--   допускает NULL: NULL = система, CLI, импорт или воркер (D-067), выдуманный автор запрещён.
--   NOT NULL — только у субъекта строки (чья сессия, чьё членство, кому уведомление) и у действий,
--   возможных лишь с устройства сотрудника (skips, proposals, phone_probes).
-- - Схема не указывается явно: таблицы создаются в текущей схеме (тесты гоняют файл во временной).
-- - Выполняет migrate под crm_owner в одной транзакции под advisory lock; учёт schema_migrations
--   (имя + sha256) ведёт раннер, а не этот файл. Права crm_app — deploy/postgres/grants.sql.
-- - Без BEGIN/COMMIT и без CONCURRENTLY: транзакцию открывает раннер.

-- Триграммный поиск по названию и 5+ цифрам номера. pg_trgm — доверенное расширение (PG 13+):
-- владелец БД ставит его без суперпользователя. Схема public задана явно, чтобы операторный класс
-- находился и при прогоне файла во временной схеме теста.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- ========================================================================================
-- Платформа: сотрудники, сессии, пространства, команды, настройки, задачи воркера
-- ========================================================================================

-- Сотрудники установки. Не удаляются: отключение = status 'disabled' (ссылки в отчётах живут).
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone_digits  TEXT NOT NULL CHECK (phone_digits ~ '^[0-9]{10,15}$'), -- pii (сотрудник): вход по номеру, только цифры
  name          TEXT NOT NULL,                                          -- pii (сотрудник)
  password_hash TEXT,                          -- bcrypt; NULL до принятия приглашения
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,-- права установки, не данные клиентов (ARCHITECTURE §5.1 п. 4)
  locale        TEXT NOT NULL DEFAULT 'ru' CONSTRAINT users_locale_check CHECK (locale IN ('ru','kk')),
  status        TEXT NOT NULL DEFAULT 'active' CONSTRAINT users_status_check CHECK (status IN ('active','disabled')),
  created_at    BIGINT NOT NULL,
  last_login_at BIGINT,
  disabled_at   BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uq ON users (phone_digits);

-- Сессии: id = sha256(токен) в hex, сам токен только в cookie. «Выйти везде» = DELETE по user_id.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,              -- скользящий срок security.sessionDays
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);   -- purge

-- Пространства (отделы). Подписи — в global.spaces настроек; здесь ключ и признаки.
CREATE TABLE IF NOT EXISTS spaces (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_default ON spaces ((true)) WHERE is_default;

-- Команды пространства (отделы для передач, команды РОП). Создаёт config apply по teams[].
CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  key          TEXT NOT NULL,
  lead_user_id TEXT REFERENCES users(id),     -- руководитель отдела (назначает администратор)
  archived_at  BIGINT,
  created_at   BIGINT NOT NULL,
  UNIQUE (space_id, key)
);

-- Приглашения и сброс пароля по ссылке: хранится только sha256 токена.
-- Пространство и роль задаются вместе или не задаются вовсе (сброс пароля, администратор без роли).
CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  kind         TEXT NOT NULL DEFAULT 'invite' CONSTRAINT invites_kind_check CHECK (kind IN ('invite','reset')),
  phone_digits TEXT NOT NULL CHECK (phone_digits ~ '^[0-9]{10,15}$'), -- pii (сотрудник)
  space_id     TEXT REFERENCES spaces(id),
  role_key     TEXT NOT NULL DEFAULT '',      -- роль из настроек; '' = без роли
  team_id      TEXT REFERENCES teams(id),
  expires_at   BIGINT NOT NULL,              -- security.inviteTtlHours
  used_at      BIGINT,
  created_by   TEXT REFERENCES users(id),     -- NULL: CLI (первый администратор, сброс пароля из crmctl)
  created_at   BIGINT NOT NULL,
  CHECK ((space_id IS NULL) = (role_key = '')),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS invites_phone_idx   ON invites (phone_digits) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS invites_expires_idx ON invites (expires_at);    -- purge

-- Членство: одна роль сотрудника в пространстве. Права перечитываются на каждом запросе (§5.2).
CREATE TABLE IF NOT EXISTS memberships (
  user_id         TEXT NOT NULL REFERENCES users(id),
  space_id        TEXT NOT NULL REFERENCES spaces(id),
  role_key        TEXT NOT NULL,             -- роль из настроек
  team_id         TEXT REFERENCES teams(id),
  in_distribution BOOLEAN NOT NULL DEFAULT FALSE,
  paused_on       TEXT NOT NULL DEFAULT '' CHECK (paused_on = '' OR paused_on ~ '^\d{4}-\d{2}-\d{2}$'), -- «Пауза» на этот местный день
  status          TEXT NOT NULL DEFAULT 'active' CONSTRAINT memberships_status_check CHECK (status IN ('active','disabled')),
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, space_id)
);
CREATE INDEX IF NOT EXISTS memberships_space_role_idx ON memberships (space_id, role_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memberships_team_idx       ON memberships (team_id) WHERE team_id IS NOT NULL;

-- «Отсутствует» (D-041): даты включительно, местные.
CREATE TABLE IF NOT EXISTS absences (
  id                 TEXT PRIMARY KEY,
  space_id           TEXT NOT NULL REFERENCES spaces(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  from_day           TEXT NOT NULL CHECK (from_day ~ '^\d{4}-\d{2}-\d{2}$'),
  to_day             TEXT NOT NULL CHECK (to_day ~ '^\d{4}-\d{2}-\d{2}$'),
  substitute_user_id TEXT REFERENCES users(id), -- NULL = поровну между работающими
  created_by         TEXT REFERENCES users(id), -- NULL: система или CLI
  created_at         BIGINT NOT NULL,
  cancelled_at       BIGINT,
  CHECK (from_day <= to_day)
);
CREATE INDEX IF NOT EXISTS absences_user_idx ON absences (space_id, user_id, from_day);

-- Ревизии документа настроек ConfigV1 (CONFIG §2, D-014, D-060). Только добавление: у crm_app нет
-- UPDATE и DELETE. Текущая = максимальная rev области со schema_version не выше известной версии.
CREATE TABLE IF NOT EXISTS config_revisions (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,              -- 'global' или id пространства
  rev            INTEGER NOT NULL CHECK (rev >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  doc            JSONB NOT NULL,
  hash           TEXT NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'), -- sha256 канонического JSON
  source         TEXT NOT NULL CONSTRAINT config_revisions_source_check
                   CHECK (source IN ('preset','ui','cli','migration','rollback')),
  preset_doc     JSONB,                      -- собранный пресет при source='preset' (D-061)
  note           TEXT NOT NULL DEFAULT '',
  author_id      TEXT REFERENCES users(id),  -- NULL: CLI или миграция настроек
  created_at     BIGINT NOT NULL,
  UNIQUE (scope, rev)
);
CREATE INDEX IF NOT EXISTS config_revisions_compat_idx ON config_revisions (scope, schema_version, rev DESC);

-- Прогоны фоновых задач (D-018): один прогон на слот. Повтор упавшего — attempt+1 в той же строке.
CREATE TABLE IF NOT EXISTS job_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,
  slot_key    TEXT NOT NULL,                 -- '2026-10-28T11' и т. п., считает slotFor()
  status      TEXT NOT NULL CONSTRAINT job_runs_status_check CHECK (status IN ('running','ok','failed','skipped')),
  attempt     INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  started_at  BIGINT NOT NULL,
  finished_at BIGINT,
  stats       JSONB NOT NULL DEFAULT '{}',   -- только числа
  error       TEXT NOT NULL DEFAULT '',      -- код и текст без ПДн
  UNIQUE (job, slot_key)
);
CREATE INDEX IF NOT EXISTS job_runs_recent_idx ON job_runs (job, started_at DESC);

-- Колокол. Пишется в транзакции события; push — через push_outbox.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id   TEXT NOT NULL DEFAULT '',      -- полиморфная ссылка: без FK
  params      JSONB NOT NULL DEFAULT '{}',   -- только коды, числа и id
  dedupe_key  TEXT,                          -- 'digest:<user>:<дата>' и т. п.
  not_before  BIGINT NOT NULL,               -- тихие часы: push не раньше
  created_at  BIGINT NOT NULL,
  read_at     BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_idx   ON notifications (user_id, created_at DESC);

-- Подписки web-push (по устройству).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  device_id   TEXT NOT NULL DEFAULT '',      -- случайный id из IndexedDB (как device_status)
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  last_ok_at  BIGINT,
  disabled_at BIGINT                         -- 404/410 от push-сервиса
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id) WHERE disabled_at IS NULL;

-- Очередь push (по образцу crp-kz mail_outbox): SKIP LOCKED, аренда, повторы. Текст без ПДн (D-033).
CREATE TABLE IF NOT EXISTS push_outbox (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  payload         JSONB NOT NULL DEFAULT '{}', -- вид события и числа
  state           TEXT NOT NULL DEFAULT 'pending' CONSTRAINT push_outbox_state_check
                    CHECK (state IN ('pending','sent','failed','cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at         BIGINT NOT NULL,
  lease_until     BIGINT,
  error           TEXT NOT NULL DEFAULT '',
  created_at      BIGINT NOT NULL,
  sent_at         BIGINT,
  UNIQUE (notification_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS push_outbox_due_idx ON push_outbox (next_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS push_outbox_sub_idx ON push_outbox (subscription_id);

-- Состояние лицензии (§8.4): одна строка.
CREATE TABLE IF NOT EXISTS license_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  license_raw  TEXT NOT NULL DEFAULT '',
  install_id   TEXT NOT NULL,
  state        TEXT NOT NULL CONSTRAINT license_state_state_check
                 CHECK (state IN ('valid','expiring','expired','read_only','invalid','missing')),
  last_seen_at BIGINT NOT NULL,              -- монотонные часы: «сейчас» = max(часы, last_seen_at)
  checked_at   BIGINT NOT NULL
);

-- Аудит (как crp-kz + space_id). Только добавление: у crm_app только INSERT и SELECT.
-- Без FK, чтобы журнал не зависел от сущностей. ПДн не пишутся: только id и коды.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,                           -- NULL: система или CLI
  space_id   TEXT,                           -- NULL: действие уровня установки
  action     TEXT NOT NULL,                  -- 'auth.login', 'export.report', 'client.merge', ...
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  meta       JSONB NOT NULL DEFAULT '{}',    -- коды, числа, id — без значений ПДн. Журнал выгрузок:
                                             -- вид, коды полей фильтра (без значений: текст поиска,
                                             -- номер, имя сюда не пишутся), число строк
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx  ON audit_log (entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS audit_log_action_idx  ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx   ON audit_log (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;

-- Неотправленные итоги на устройствах (D-063). Без ПДн.
CREATE TABLE IF NOT EXISTS device_status (
  user_id        TEXT NOT NULL REFERENCES users(id),
  device_id      TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 64),
  pending_outbox INTEGER NOT NULL DEFAULT 0 CHECK (pending_outbox >= 0),
  last_flush_at  BIGINT,
  seen_at        BIGINT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- Журнал проверок номера (D-040): общий счётчик security.phoneProbesPerDay. Номер не хранится.
CREATE TABLE IF NOT EXISTS phone_probes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  day        TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'), -- местные сутки
  path       TEXT NOT NULL CONSTRAINT phone_probes_path_check
               CHECK (path IN ('proposal','add_phone','walk_in','manual_create')),
  matched    BOOLEAN NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS phone_probes_user_day_idx ON phone_probes (user_id, day);

-- ========================================================================================
-- Клиенты: общие на установку (D-012)
-- ========================================================================================

CREATE TABLE IF NOT EXISTS clients (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CONSTRAINT clients_kind_check CHECK (kind IN ('company','person')),
  name              TEXT NOT NULL,           -- pii
  name_norm         TEXT NOT NULL,           -- pii: нормализованное название для дедупа
  legal_form        TEXT NOT NULL DEFAULT '',-- код из org.legalForms
  org_id            TEXT NOT NULL DEFAULT '',-- pii: БИН по org.idRule, '' если нет; у ИП ('idIsPersonal') всегда ''
  iin_hmac          TEXT CHECK (iin_hmac ~ '^[0-9a-f]{64}$'), -- pii: ИИН только HMAC-SHA256 hex (у ИП — их 12 цифр, D-052)
  region            TEXT NOT NULL DEFAULT '',
  address           TEXT NOT NULL DEFAULT '',-- pii
  email             TEXT NOT NULL DEFAULT '',-- pii
  website           TEXT NOT NULL DEFAULT '',-- pii
  custom            JSONB NOT NULL DEFAULT '{}', -- pii (поля с pii в настройках): значения полей объекта client
  search_norm       TEXT NOT NULL DEFAULT '',-- pii: название + номера + поля searchable
  source_kind       TEXT NOT NULL CONSTRAINT clients_source_kind_check
                      CHECK (source_kind IN ('import','ingest','manual','proposal','messenger','telephony','walk_in')),
  source_key        TEXT NOT NULL DEFAULT '',-- подпись из sources.<key>.label
  merged_into_id    TEXT REFERENCES clients(id), -- слит в этого клиента; строка не удаляется
  depersonalized_at BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_uq ON clients (org_id)   WHERE org_id <> '' AND merged_into_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_iin_uq ON clients (iin_hmac) WHERE iin_hmac IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS clients_name_norm_idx ON clients (name_norm) WHERE merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS clients_merged_idx    ON clients (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_search_trgm   ON clients USING GIN (search_norm public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_custom_gin    ON clients USING GIN (custom jsonb_path_ops);

CREATE TABLE IF NOT EXISTS contacts (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id),
  name              TEXT NOT NULL DEFAULT '',-- pii
  position          TEXT NOT NULL DEFAULT '',-- pii
  is_decision_maker BOOLEAN NOT NULL DEFAULT FALSE,
  call_hint         TEXT NOT NULL DEFAULT '',-- pii: «когда звонить» и т. п.
  note              TEXT NOT NULL DEFAULT '',-- pii
  custom            JSONB NOT NULL DEFAULT '{}', -- pii (поля с pii): значения полей объекта contact (CONFIG §6.11)
  created_at        BIGINT NOT NULL,
  archived_at       BIGINT
);
CREATE INDEX IF NOT EXISTS contacts_client_idx ON contacts (client_id);

-- Номера клиента. Глобально номер не уникален: общий бухгалтер у разных ТОО — норма (D-038).
CREATE TABLE IF NOT EXISTS client_phones (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES clients(id),
  contact_id   TEXT REFERENCES contacts(id),
  digits       TEXT NOT NULL CHECK (digits ~ '^[0-9]{1,20}$'), -- pii
  ext          TEXT NOT NULL DEFAULT '',     -- pii: добавочный
  kind         TEXT NOT NULL CONSTRAINT client_phones_kind_check CHECK (kind IN ('mobile','landline','unknown')),
  is_working   BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  has_whatsapp TEXT NOT NULL DEFAULT 'unknown' CONSTRAINT client_phones_has_whatsapp_check
                 CHECK (has_whatsapp IN ('yes','no','unknown')),
  created_at   BIGINT NOT NULL,
  UNIQUE (client_id, digits)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_phones_one_primary ON client_phones (client_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS client_phones_digits_idx  ON client_phones (digits);
CREATE INDEX IF NOT EXISTS client_phones_digits_trgm ON client_phones USING GIN (digits public.gin_trgm_ops); -- поиск по 5+ цифрам
CREATE INDEX IF NOT EXISTS client_phones_contact_idx ON client_phones (contact_id) WHERE contact_id IS NOT NULL;

-- Стоп-лист (D-021): HMAC номера, ключ в окружении. Переживает слияние и обезличивание намеренно,
-- поэтому в реестр обезличивания не входит. Открытый номер сюда не попадёт: CHECK на hex.
CREATE TABLE IF NOT EXISTS stop_list (
  phone_hmac  TEXT PRIMARY KEY CHECK (phone_hmac ~ '^[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL,
  source      TEXT NOT NULL CONSTRAINT stop_list_source_check
                CHECK (source IN ('outcome','manual','depersonalize','import')),
  created_by  TEXT REFERENCES users(id),     -- NULL: система
  created_at  BIGINT NOT NULL
);

-- Загрузки таблиц (C4). Файл не хранится; report — только счётчики.
CREATE TABLE IF NOT EXISTS imports (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  file_name   TEXT NOT NULL DEFAULT '',
  file_sha256 TEXT NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  profile_key TEXT NOT NULL,                 -- import.profiles[].key
  status      TEXT NOT NULL DEFAULT 'preview' CONSTRAINT imports_status_check
                CHECK (status IN ('preview','applied','failed')),
  report      JSONB NOT NULL DEFAULT '{}',   -- только счётчики
  created_by  TEXT REFERENCES users(id),     -- NULL: ночная дозагрузка (воркер) или CLI
  created_at  BIGINT NOT NULL,
  applied_at  BIGINT
);
CREATE INDEX IF NOT EXISTS imports_space_idx ON imports (space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS imports_file_idx  ON imports (space_id, file_sha256);

-- Строки загрузки для предпросмотра и разбора. Удаляются задачей purge через import.rowsRetentionDays.
CREATE TABLE IF NOT EXISTS import_rows (
  id         TEXT PRIMARY KEY,
  import_id  TEXT NOT NULL REFERENCES imports(id),
  row_no     INTEGER NOT NULL CHECK (row_no >= 1),
  import_key TEXT NOT NULL,                  -- ключ строки + ключ состояния (D-048)
  parsed     JSONB NOT NULL,                 -- pii: разобранная строка таблицы
  issue      TEXT NOT NULL DEFAULT '',       -- код проблемы строки, без значений
  client_id  TEXT REFERENCES clients(id),
  created_at BIGINT NOT NULL,
  UNIQUE (import_id, row_no)
);
CREATE INDEX IF NOT EXISTS import_rows_key_idx     ON import_rows (import_key);
CREATE INDEX IF NOT EXISTS import_rows_created_idx ON import_rows (created_at);           -- purge
CREATE INDEX IF NOT EXISTS import_rows_client_idx  ON import_rows (client_id) WHERE client_id IS NOT NULL;

-- Ключи API приёма ingest/v1 (INTEGRATIONS §5.1): хранится sha256 секрета.
CREATE TABLE IF NOT EXISTS ingest_keys (
  id           TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{8}$'),
  key_hash     TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  source_key   TEXT NOT NULL,                -- sources.<key>; идемпотентность — по источнику, не по ключу
  scopes       TEXT[] NOT NULL CONSTRAINT ingest_keys_scopes_check
                 CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY['leads:write','leads:demand']::TEXT[]),
  managed      TEXT NOT NULL CONSTRAINT ingest_keys_managed_check CHECK (managed IN ('ui','cli')), -- 'cli' в интерфейсе не виден
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT,                       -- обновляется не чаще раза в минуту
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS ingest_keys_source_idx ON ingest_keys (source_key) WHERE revoked_at IS NULL;

-- Партии приёма: повтор (source_key, batch_id) с тем же request_hash возвращает сохранённый отчёт.
-- Удаляются через 30 дней (D-056).
CREATE TABLE IF NOT EXISTS ingest_batches (
  id           TEXT PRIMARY KEY,
  key_id       TEXT NOT NULL REFERENCES ingest_keys(id),
  source_key   TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'), -- sha256 канонического тела
  report       JSONB NOT NULL,               -- pii: счётчики и статусы по externalId (externalId — в реестре)
  received_at  BIGINT NOT NULL,
  UNIQUE (source_key, batch_id)
);
CREATE INDEX IF NOT EXISTS ingest_batches_received_idx ON ingest_batches (received_at);   -- purge

-- Откуда пришёл клиент. Узнавание externalId — по источнику: ротация ключа его не ломает.
CREATE TABLE IF NOT EXISTS client_sources (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  source_kind   TEXT NOT NULL CONSTRAINT client_sources_source_kind_check
                  CHECK (source_kind IN ('import','ingest','manual','proposal','messenger','telephony','walk_in')),
  source_key    TEXT NOT NULL DEFAULT '',
  ingest_key_id TEXT REFERENCES ingest_keys(id),
  import_id     TEXT REFERENCES imports(id),
  external_id   TEXT,                        -- pii: id записи у источника
  first_seen_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS client_sources_ext_uq ON client_sources (source_key, external_id)
  WHERE source_key <> '' AND external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_sources_client_idx ON client_sources (client_id);

-- Спорные пары («ложная склейка хуже дубля»). a < b — пара хранится один раз.
CREATE TABLE IF NOT EXISTS dup_pairs (
  id          TEXT PRIMARY KEY,
  a_client_id TEXT NOT NULL REFERENCES clients(id),
  b_client_id TEXT NOT NULL REFERENCES clients(id),
  reason      TEXT NOT NULL CONSTRAINT dup_pairs_reason_check CHECK (reason IN ('shared_phone','name_and_head')),
  status      TEXT NOT NULL DEFAULT 'open' CONSTRAINT dup_pairs_status_check
                CHECK (status IN ('open','merged','distinct','split_allowed')),
  comment     TEXT NOT NULL DEFAULT '',      -- pii: комментарий РОП
  resolved_by TEXT REFERENCES users(id),
  resolved_at BIGINT,
  created_at  BIGINT NOT NULL,
  CHECK (a_client_id < b_client_id),
  UNIQUE (a_client_id, b_client_id, reason)
);
CREATE INDEX IF NOT EXISTS dup_pairs_b_idx    ON dup_pairs (b_client_id);
CREATE INDEX IF NOT EXISTS dup_pairs_open_idx ON dup_pairs (created_at) WHERE status = 'open';

-- Согласия клиента (как D-035 crp-kz). Только добавление: отзыв — новой строкой action='revoked'.
CREATE TABLE IF NOT EXISTS consents (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  kind        TEXT NOT NULL CONSTRAINT consents_kind_check CHECK (kind IN ('messenger_crossborder','call_recording')),
  action      TEXT NOT NULL CONSTRAINT consents_action_check CHECK (action IN ('given','revoked')),
  at          BIGINT NOT NULL,
  text_hash   TEXT NOT NULL DEFAULT '' CHECK (text_hash = '' OR text_hash ~ '^[0-9a-f]{64}$'), -- sha256 текста согласия
  recorded_by TEXT REFERENCES users(id),
  created_at  BIGINT NOT NULL,
  CHECK (action = 'revoked' OR text_hash <> '')
);
CREATE INDEX IF NOT EXISTS consents_client_idx ON consents (client_id, kind, at DESC);

-- Снимки «до» для ручного отката слияния и массовой передачи (D-062). Чистятся через 30 дней.
CREATE TABLE IF NOT EXISTS change_snapshots (
  id           TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  kind         TEXT NOT NULL CONSTRAINT change_snapshots_kind_check CHECK (kind IN ('merge','bulk_transfer')),
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,                -- полиморфная ссылка: без FK
  client_id    TEXT REFERENCES clients(id),  -- клиент строки: по нему чистит обезличивание
  before       JSONB NOT NULL,               -- pii: строка целиком до операции
  created_by   TEXT REFERENCES users(id),    -- NULL: система или CLI
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_snapshots_op_idx      ON change_snapshots (operation_id);
CREATE INDEX IF NOT EXISTS change_snapshots_created_idx ON change_snapshots (created_at); -- purge
CREATE INDEX IF NOT EXISTS change_snapshots_client_idx  ON change_snapshots (client_id) WHERE client_id IS NOT NULL;

-- ========================================================================================
-- Карточки обзвона и звонки (PROCESS §3)
-- ========================================================================================

-- Работа отдела с клиентом: одна карточка на пару (пространство, клиент). 9 состояний — PROCESS 3.1.
CREATE TABLE IF NOT EXISTS cards (
  id                TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  client_id         TEXT NOT NULL REFERENCES clients(id),
  owner_user_id     TEXT REFERENCES users(id), -- NULL = пул
  acting_user_id    TEXT REFERENCES users(id), -- временный владелец («Отсутствует», D-041)
  acting_until_day  TEXT NOT NULL DEFAULT '' CHECK (acting_until_day = '' OR acting_until_day ~ '^\d{4}-\d{2}-\d{2}$'),
  state             TEXT NOT NULL DEFAULT 'new' CONSTRAINT cards_state_check CHECK (state IN
                      ('new','retry','callback','agreed','client','not_interested','not_target','do_not_call','written_off')),
  hold_reason       TEXT NOT NULL DEFAULT '' CONSTRAINT cards_hold_reason_check
                      CHECK (hold_reason IN ('','dup_pair','import_conflict','no_working_phone','rule')),
  hold_code         TEXT NOT NULL DEFAULT '',-- код правила задержки из настроек
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0), -- недозвоны подряд
  next_call_at      BIGINT,                  -- источник правды перезвона (D-050)
  return_at         BIGINT,
  lpr               TEXT NOT NULL DEFAULT '' CONSTRAINT cards_lpr_check CHECK (lpr IN ('','yes','no')),
  is_target         TEXT NOT NULL DEFAULT '' CONSTRAINT cards_is_target_check CHECK (is_target IN ('','yes','no')),
  last_outcome_code TEXT NOT NULL DEFAULT '',
  last_outcome_kind TEXT NOT NULL DEFAULT '',
  last_outcome_at   BIGINT,                  -- occurred_at последнего применённого итога
  close_reason_code TEXT NOT NULL DEFAULT '',
  closed_at         BIGINT,
  assigned_at       BIGINT,
  touched_in_crm    BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE после итога, правки или раздачи в CRM (не импорта)
  calls_total       INTEGER NOT NULL DEFAULT 0 CHECK (calls_total >= 0),
  connects_total    INTEGER NOT NULL DEFAULT 0 CHECK (connects_total >= 0),
  no_answer_total   INTEGER NOT NULL DEFAULT 0 CHECK (no_answer_total >= 0),
  first_connect_at  BIGINT,
  last_connect_at   BIGINT,
  last_touch_at     BIGINT,
  custom            JSONB NOT NULL DEFAULT '{}', -- pii (поля с pii): значения полей объекта card
  version           INTEGER NOT NULL DEFAULT 0,  -- UPDATE … WHERE version = $v (PROCESS 3.5)
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  UNIQUE (space_id, client_id)
);
CREATE INDEX IF NOT EXISTS cards_queue_idx  ON cards (space_id, owner_user_id, state, next_call_at);
CREATE INDEX IF NOT EXISTS cards_acting_idx ON cards (space_id, acting_user_id) WHERE acting_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cards_pool_idx   ON cards (space_id, created_at)
  WHERE owner_user_id IS NULL AND state = 'new' AND hold_reason = '';
CREATE INDEX IF NOT EXISTS cards_hold_idx   ON cards (space_id, hold_reason) WHERE hold_reason <> '';
CREATE INDEX IF NOT EXISTS cards_return_idx ON cards (space_id, return_at) WHERE state = 'not_interested';
CREATE INDEX IF NOT EXISTS cards_client_idx ON cards (client_id);

-- Звонки и итоги. id = opId с устройства: повтор = ON CONFLICT (id) DO NOTHING (D-019).
CREATE TABLE IF NOT EXISTS calls (
  id                    TEXT PRIMARY KEY,
  space_id              TEXT NOT NULL REFERENCES spaces(id),
  card_id               TEXT NOT NULL REFERENCES cards(id),
  client_id             TEXT NOT NULL REFERENCES clients(id),
  user_id               TEXT REFERENCES users(id), -- кто звонил; NULL: импорт или телефония без оператора
  owner_user_id_at_call TEXT REFERENCES users(id),
  direction             TEXT NOT NULL DEFAULT 'out' CONSTRAINT calls_direction_check CHECK (direction IN ('out','in')),
  via                   TEXT NOT NULL CONSTRAINT calls_via_check
                          CHECK (via IN ('ui','offline','import','telephony','manual_entry')),
  phone_digits          TEXT NOT NULL DEFAULT '', -- pii
  outcome_code          TEXT NOT NULL,       -- ключ итога из настроек
  outcome_kind          TEXT NOT NULL CONSTRAINT calls_outcome_kind_check CHECK (outcome_kind IN
                          ('no_answer','bad_number','callback','agreed','not_interested','not_target','do_not_call')),
  reason_code           TEXT NOT NULL DEFAULT '',
  note                  TEXT NOT NULL DEFAULT '', -- pii: заметка и текст причины «Другое»
  lpr                   TEXT NOT NULL DEFAULT '' CONSTRAINT calls_lpr_check CHECK (lpr IN ('','yes','no')),
  callback_at           BIGINT,
  fields_patch          JSONB NOT NULL DEFAULT '{}', -- pii: поля, заполненные в шторке
  applied               TEXT NOT NULL CONSTRAINT calls_applied_check CHECK (applied IN ('applied','fact_only')),
  fact_reason           TEXT NOT NULL DEFAULT '' CONSTRAINT calls_fact_reason_check
                          CHECK (fact_reason IN ('','owner_changed','stale')),
  tapped_at             BIGINT,
  occurred_at           BIGINT NOT NULL,     -- время с устройства в окне [received − 72 ч, received + 5 мин]
  received_at           BIGINT NOT NULL,
  duration_sec          INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
  duration_source       TEXT NOT NULL DEFAULT 'none' CONSTRAINT calls_duration_source_check
                          CHECK (duration_source IN ('none','manual_estimate','provider')),
  telephony_call_id     TEXT,                -- ссылка на telephony_calls (таблица — с первым живым адаптером): без FK
  import_key            TEXT,                -- ключ строки + ключ состояния (D-048)
  config_rev            INTEGER NOT NULL,
  CHECK ((applied = 'applied') = (fact_reason = '')),
  -- Звонок из интерфейса или с устройства всегда с автором; без автора — только системные каналы
  CONSTRAINT calls_user_id_check CHECK (user_id IS NOT NULL OR via IN ('import','telephony'))
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_import_uq ON calls (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_card_idx   ON calls (card_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS calls_stats_idx  ON calls (space_id, user_id, occurred_at) WHERE via <> 'import';
CREATE INDEX IF NOT EXISTS calls_client_idx ON calls (client_id);

-- Журнал раздачи (PROCESS 7.9): по нему считается лимит дня.
CREATE TABLE IF NOT EXISTS assign_log (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL REFERENCES spaces(id),
  card_id       TEXT NOT NULL REFERENCES cards(id),
  from_user_id  TEXT REFERENCES users(id),
  to_user_id    TEXT REFERENCES users(id),   -- NULL: возврат в пул
  kind          TEXT NOT NULL CONSTRAINT assign_log_kind_check CHECK (kind IN
                  ('auto','manual','return','absence','release','transfer','inbound','proposal','merge','import')),
  counts_to_cap BOOLEAN NOT NULL,            -- по distribution.capIncludes на момент выдачи
  run_id        TEXT,                        -- id прогона job_runs или ручного действия: без FK
  day           TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'), -- местные сутки
  actor_id      TEXT REFERENCES users(id),   -- NULL: система
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assign_cap_idx  ON assign_log (space_id, to_user_id, day) WHERE counts_to_cap;
CREATE INDEX IF NOT EXISTS assign_day_idx  ON assign_log (space_id, day);
CREATE INDEX IF NOT EXISTS assign_card_idx ON assign_log (card_id);

-- Пропуски: id = opId, повтор не считается дважды; лимит дня считает сервер.
CREATE TABLE IF NOT EXISTS skips (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  card_id    TEXT NOT NULL REFERENCES cards(id),
  day        TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS skips_day_idx ON skips (user_id, day);

-- «Предложить контакт» (D-040). id = opId с устройства: двойное нажатие не создаёт второе предложение.
CREATE TABLE IF NOT EXISTS proposals (
  id                TEXT PRIMARY KEY,
  space_id          TEXT NOT NULL REFERENCES spaces(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  digits            TEXT NOT NULL,           -- pii
  name              TEXT NOT NULL DEFAULT '',-- pii
  status            TEXT NOT NULL CONSTRAINT proposals_status_check CHECK (status IN ('created','review','rejected')),
  matched_client_id TEXT REFERENCES clients(id), -- совпадение, ушедшее РОП
  client_id         TEXT REFERENCES clients(id), -- созданный клиент
  resolved_by       TEXT REFERENCES users(id),
  resolved_at       BIGINT,
  created_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_user_idx   ON proposals (user_id, created_at);
CREATE INDEX IF NOT EXISTS proposals_review_idx ON proposals (space_id, created_at) WHERE status = 'review';

-- ========================================================================================
-- Запись на мероприятия (PROCESS §5)
-- ========================================================================================

-- Серии групповых мероприятий — рабочие данные РОП, не настройки (CONFIG §6.9).
CREATE TABLE IF NOT EXISTS event_series (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id),
  event_type_key TEXT NOT NULL,
  weekday        SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7), -- 1 = понедельник (ISO)
  start_time     TEXT NOT NULL CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
  location       TEXT NOT NULL DEFAULT '',
  format         TEXT NOT NULL DEFAULT '',
  capacity       INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_series_space_idx ON event_series (space_id) WHERE active;

-- Конкретные мероприятия. occurrence_key — идемпотентность генерации events-ensure.
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL REFERENCES spaces(id),
  series_id      TEXT REFERENCES event_series(id),
  event_type_key TEXT NOT NULL,
  event_date     TEXT NOT NULL CHECK (event_date ~ '^\d{4}-\d{2}-\d{2}$'),
  start_time     TEXT NOT NULL CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  starts_at      BIGINT NOT NULL,
  duration_min   INTEGER NOT NULL CHECK (duration_min > 0),
  location       TEXT NOT NULL DEFAULT '',
  format         TEXT NOT NULL DEFAULT '',
  capacity       INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  status         TEXT NOT NULL DEFAULT 'scheduled' CONSTRAINT events_status_check CHECK (status IN ('scheduled','cancelled')),
  occurrence_key TEXT,
  touched        BOOLEAN NOT NULL DEFAULT FALSE, -- ручная правка: генерация не трогает
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_occurrence_uq ON events (occurrence_key) WHERE occurrence_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_time_idx   ON events (space_id, starts_at);
CREATE INDEX IF NOT EXISTS events_series_idx ON events (series_id, event_date) WHERE series_id IS NOT NULL;

-- Дежурные мероприятия (отношение duty_today).
CREATE TABLE IF NOT EXISTS event_duty (
  event_id   TEXT NOT NULL REFERENCES events(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS event_duty_user_idx ON event_duty (user_id);

-- Консультанты (ресурсы индивидуальной записи). Не удаляются, а выключаются (active).
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  directions  TEXT[] NOT NULL DEFAULT '{}',  -- ключи booking.directions
  slot_min    INTEGER NOT NULL CHECK (slot_min > 0),
  capacity    INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  auto_assign BOOLEAN NOT NULL DEFAULT TRUE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  UNIQUE (space_id, user_id)
);

-- Недельный график: несколько окон в день; перерыв — промежуток между окнами.
CREATE TABLE IF NOT EXISTS resource_schedule (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time  TEXT NOT NULL CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  end_time    TEXT NOT NULL CHECK (end_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS resource_schedule_res_idx ON resource_schedule (resource_id, weekday);

-- Исключения по датам: выходной/отпуск ('off') или особые часы ('custom', окна в windows).
CREATE TABLE IF NOT EXISTS resource_exceptions (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  day         TEXT NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  kind        TEXT NOT NULL CONSTRAINT resource_exceptions_kind_check CHECK (kind IN ('off','custom')),
  windows     JSONB NOT NULL DEFAULT '[]',   -- [{"from":"HH:MM","to":"HH:MM"}] при kind='custom'
  created_by  TEXT REFERENCES users(id),
  created_at  BIGINT NOT NULL,
  UNIQUE (resource_id, day)
);

-- ========================================================================================
-- Сделки, записи, передачи, задачи, заметки, лента
-- ========================================================================================

-- Сделки (PROCESS §4). Одна сделка = одна покупка; деньги — целые тенге.
CREATE TABLE IF NOT EXISTS deals (
  id               TEXT PRIMARY KEY,
  space_id         TEXT NOT NULL REFERENCES spaces(id),
  pipeline_key     TEXT NOT NULL,
  stage_key        TEXT NOT NULL,
  status           TEXT NOT NULL CONSTRAINT deals_status_check CHECK (status IN ('open','won','lost')), -- копия вида этапа
  client_id        TEXT NOT NULL REFERENCES clients(id),
  card_id          TEXT NOT NULL REFERENCES cards(id),
  owner_user_id    TEXT REFERENCES users(id),
  service_type_key TEXT NOT NULL DEFAULT '',
  amount_kzt       BIGINT NOT NULL DEFAULT 0 CHECK (amount_kzt >= 0),
  won_at           BIGINT,                   -- момент покупки
  lost_at          BIGINT,
  lost_reason_code TEXT NOT NULL DEFAULT '',
  lost_reason_text TEXT NOT NULL DEFAULT '', -- pii: текст причины «Другое»
  needs_rebook     BOOLEAN NOT NULL DEFAULT FALSE,
  stage_changed_at BIGINT NOT NULL,
  custom           JSONB NOT NULL DEFAULT '{}', -- pii (поля с pii): значения полей объекта deal
  request_id       TEXT,                     -- идемпотентность покупки и создания
  version          INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES users(id),  -- NULL: система (импорт «Договорились», воркер)
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  CHECK (status <> 'won'  OR won_at  IS NOT NULL),
  CHECK (status <> 'lost' OR lost_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS deals_request_uq ON deals (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_board_idx  ON deals (space_id, pipeline_key, status, stage_key);
CREATE INDEX IF NOT EXISTS deals_client_idx ON deals (client_id);
CREATE INDEX IF NOT EXISTS deals_owner_idx  ON deals (space_id, owner_user_id, status);
CREATE INDEX IF NOT EXISTS deals_card_idx   ON deals (card_id);

-- Записи (PROCESS §5.3: 6 статусов). Групповая — на мероприятие; индивидуальная — к консультанту
-- (resource_id NULL у «серой»).
CREATE TABLE IF NOT EXISTS bookings (
  id                  TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL REFERENCES spaces(id),
  kind                TEXT NOT NULL CONSTRAINT bookings_kind_check CHECK (kind IN ('group','individual')),
  event_type_key      TEXT NOT NULL,
  event_id            TEXT REFERENCES events(id),
  resource_id         TEXT REFERENCES resources(id),
  client_id           TEXT NOT NULL REFERENCES clients(id),
  card_id             TEXT NOT NULL REFERENCES cards(id),
  deal_id             TEXT REFERENCES deals(id),
  contact_id          TEXT REFERENCES contacts(id),
  booking_date        TEXT NOT NULL CHECK (booking_date ~ '^\d{4}-\d{2}-\d{2}$'),
  start_time          TEXT NOT NULL CHECK (start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  starts_at           BIGINT NOT NULL,
  duration_min        INTEGER NOT NULL CHECK (duration_min > 0),
  direction_key       TEXT NOT NULL DEFAULT '',
  is_reserve          BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'registered' CONSTRAINT bookings_status_check CHECK (status IN
                        ('registered','confirmed','attended','no_show','cancelled','moved')),
  cancel_reason       TEXT NOT NULL DEFAULT '' CONSTRAINT bookings_cancel_reason_check
                        CHECK (cancel_reason IN ('','client','event_cancelled','operator_error','do_not_call')),
  via                 TEXT NOT NULL DEFAULT 'ui' CONSTRAINT bookings_via_check CHECK (via IN ('ui','import','walk_in')),
  booked_by_user_id   TEXT REFERENCES users(id), -- заслуга (не меняется при передаче, D-042); NULL: импорт без оператора, система
  responsible_user_id TEXT REFERENCES users(id),          -- ответственный (меняется при передаче)
  moved_from_id       TEXT REFERENCES bookings(id),
  moved_to_id         TEXT REFERENCES bookings(id),
  grey_processed_at   BIGINT,
  custom              JSONB NOT NULL DEFAULT '{}', -- pii (поля с pii): значения полей объекта booking
  request_id          TEXT,                  -- opId мастера «Договорились — записать»
  import_key          TEXT,                  -- профиль импорта «Записи» (PROCESS 12.39)
  version             INTEGER NOT NULL DEFAULT 0,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  CHECK (kind <> 'group' OR event_id IS NOT NULL),
  CHECK (kind <> 'individual' OR event_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_group_uq ON bookings (event_id, client_id)
  WHERE kind = 'group' AND status IN ('registered','confirmed','attended','no_show');
CREATE UNIQUE INDEX IF NOT EXISTS bookings_request_uq ON bookings (request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_import_uq  ON bookings (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_event_idx    ON bookings (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_resource_idx ON bookings (resource_id, booking_date);
CREATE INDEX IF NOT EXISTS bookings_resp_idx     ON bookings (space_id, responsible_user_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_client_idx   ON bookings (client_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_deal_idx     ON bookings (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_grey_idx     ON bookings (space_id, booking_date)
  WHERE kind = 'individual' AND resource_id IS NULL AND status IN ('registered','confirmed');

-- История статусов записи. Только добавление.
CREATE TABLE IF NOT EXISTS booking_history (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id),
  action      TEXT NOT NULL,                 -- 'created','status','moved','assigned','walk_in', ...
  from_status TEXT NOT NULL DEFAULT '',
  to_status   TEXT NOT NULL DEFAULT '',
  actor_id    TEXT REFERENCES users(id),     -- NULL: система
  meta        JSONB NOT NULL DEFAULT '{}',   -- коды и id, без ПДн
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_history_booking_idx ON booking_history (booking_id, created_at);

-- Передачи в отдел: одна на сделку.
CREATE TABLE IF NOT EXISTS handoffs (
  id               TEXT PRIMARY KEY,
  space_id_from    TEXT NOT NULL REFERENCES spaces(id),
  space_id_to      TEXT NOT NULL REFERENCES spaces(id),
  team_id          TEXT NOT NULL REFERENCES teams(id),
  deal_id          TEXT NOT NULL UNIQUE REFERENCES deals(id),
  client_id        TEXT NOT NULL REFERENCES clients(id),
  status           TEXT NOT NULL DEFAULT 'pending' CONSTRAINT handoffs_status_check
                     CHECK (status IN ('pending','accepted','declined','cancelled')),
  assignee_user_id TEXT REFERENCES users(id),
  due_at           BIGINT NOT NULL,
  accepted_at      BIGINT,
  accepted_by      TEXT REFERENCES users(id),
  declined_reason  TEXT NOT NULL DEFAULT '', -- pii: текст причины отказа
  alarm_sent_at    BIGINT,
  created_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_inbox_idx    ON handoffs (team_id, status);
CREATE INDEX IF NOT EXISTS handoffs_client_idx   ON handoffs (client_id);
CREATE INDEX IF NOT EXISTS handoffs_assignee_idx ON handoffs (assignee_user_id) WHERE assignee_user_id IS NOT NULL;

-- Задачи (PROCESS §6). Автозадача не задваивается: одна ОТКРЫТАЯ задача на source_key (повтор —
-- ON CONFLICT DO NOTHING). Закрытая задача ключ не держит: второе сообщение после ответа, повторный
-- пропущенный, новая неявка по той же записи создают новую задачу.
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  space_id         TEXT NOT NULL REFERENCES spaces(id),
  client_id        TEXT NOT NULL REFERENCES clients(id),
  deal_id          TEXT REFERENCES deals(id),
  kind             TEXT NOT NULL CONSTRAINT tasks_kind_check
                     CHECK (kind IN ('call','message','meeting','handoff','check','other')),
  source           TEXT NOT NULL CONSTRAINT tasks_source_check CHECK (source IN ('manual','callback','no_show','rebook',
                     'inbound_message','missed_call','handoff','grey_unassigned','dnc_inbound','review','proposal',
                     'attendance_mark','next_step','agreement','clarify_import','absent_review',
                     'staff_disabled','stoplist_confirm')),
  title            TEXT NOT NULL,            -- pii: может содержать имя
  due_at           BIGINT,
  assignee_user_id TEXT REFERENCES users(id),
  team_id          TEXT REFERENCES teams(id),
  status           TEXT NOT NULL DEFAULT 'open' CONSTRAINT tasks_status_check CHECK (status IN ('open','done','cancelled')),
  source_key       TEXT,                     -- 'reply:<chatId>', 'missed:<externalCallId>', 'no_show:<bookingId>', ...
  created_by       TEXT REFERENCES users(id),-- NULL: система
  done_at          BIGINT,
  created_at       BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_uq ON tasks (source_key) WHERE source_key IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_user_id, status, due_at);
CREATE INDEX IF NOT EXISTS tasks_client_idx   ON tasks (client_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tasks_space_due_idx ON tasks (space_id, due_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tasks_deal_idx     ON tasks (deal_id) WHERE deal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  author_id  TEXT REFERENCES users(id),      -- NULL: система (например, передача дел, D-066)
  body       TEXT NOT NULL,                  -- pii
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments (task_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  deal_id    TEXT REFERENCES deals(id),
  author_id  TEXT REFERENCES users(id),      -- NULL: импорт или система
  body       TEXT NOT NULL,                  -- pii
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at  BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_client_idx ON notes (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notes_deal_idx   ON notes (deal_id) WHERE deal_id IS NOT NULL;

-- Лента клиента (D-020). Только добавление: у crm_app нет UPDATE и DELETE. Слияние ленту не
-- переписывает: лента выжившего читается по нему и по клиентам с merged_into_id = выживший (D-068).
CREATE TABLE IF NOT EXISTS client_events (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  space_id   TEXT NOT NULL REFERENCES spaces(id),
  deal_id    TEXT REFERENCES deals(id),
  kind       TEXT NOT NULL,                  -- 'call','call.voided','booking.created','deal.stage', ...
  actor_id   TEXT REFERENCES users(id),      -- NULL: система
  at         BIGINT NOT NULL,
  ref_type   TEXT NOT NULL DEFAULT '',
  ref_id     TEXT NOT NULL DEFAULT '',       -- полиморфная ссылка: без FK
  data       JSONB NOT NULL DEFAULT '{}'     -- pii: коды, id, числа; значения полей — только для полей с access
);
CREATE INDEX IF NOT EXISTS client_events_feed_idx ON client_events (client_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS client_events_deal_idx ON client_events (deal_id, at DESC) WHERE deal_id IS NOT NULL;

-- ========================================================================================
-- Интеграции (INTEGRATIONS §1, §3.2, §4). Таблицы телефонии — отдельной миграцией с первым живым
-- адаптером (INTEGRATIONS §2.7, D-069).
-- ========================================================================================

CREATE TABLE IF NOT EXISTS integrations (
  id                      TEXT PRIMARY KEY,
  plugin_id               TEXT NOT NULL,     -- 'telephony.manual', 'messenger.wazzup', ...: список — реестр кода
  space_id                TEXT REFERENCES spaces(id), -- NULL = вся установка
  config                  JSONB NOT NULL DEFAULT '{}', -- несекретные настройки
  enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  status                  TEXT NOT NULL DEFAULT 'unknown', -- код healthCheck
  webhook_token_hash      TEXT UNIQUE CHECK (webhook_token_hash ~ '^[0-9a-f]{64}$'), -- sha256 токена из пути вебхука
  last_event_at           BIGINT,
  crossborder_approved_at BIGINT,            -- отметка «есть письменное решение о передаче ПДн за рубеж»
  crossborder_approved_by TEXT REFERENCES users(id),
  created_at              BIGINT NOT NULL,
  updated_at              BIGINT NOT NULL
);

-- Секреты интеграций: AES-256-GCM, AAD = integration_id|name|kid; ключ — только в окружении.
CREATE TABLE IF NOT EXISTS integration_secrets (
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  name           TEXT NOT NULL,
  kid            TEXT NOT NULL,
  iv             BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext     BYTEA NOT NULL,
  tag            BYTEA NOT NULL CHECK (octet_length(tag) = 16),
  last4          TEXT NOT NULL DEFAULT '',   -- «задан, …последние 4 символа» для UI
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (integration_id, name)
);
CREATE INDEX IF NOT EXISTS integration_secrets_kid_idx ON integration_secrets (kid);    -- crmctl secrets rotate

-- Входящие вебхуки: сырое событие, ответ 200 сразу; разбирает воркер (SKIP LOCKED).
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id             TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  dedupe_key     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload        JSONB,                      -- pii: обнуляется через 14 дней (purge)
  state          TEXT NOT NULL DEFAULT 'pending' CONSTRAINT webhook_inbox_state_check
                   CHECK (state IN ('pending','done','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_at        BIGINT NOT NULL,
  lease_until    BIGINT,
  error          TEXT NOT NULL DEFAULT '',   -- код ошибки, без ПДн
  received_at    BIGINT NOT NULL,
  processed_at   BIGINT,
  UNIQUE (integration_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS webhook_inbox_pending_idx ON webhook_inbox (state, next_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS webhook_inbox_purge_idx   ON webhook_inbox (received_at) WHERE payload IS NOT NULL;

-- Мессенджер Wazzup (INTEGRATIONS §3.2): каналы, чаты, сообщения. Модуль за флагом FEATURE_WAZZUP.
CREATE TABLE IF NOT EXISTS messenger_channels (
  id                  TEXT PRIMARY KEY,
  integration_id      TEXT NOT NULL REFERENCES integrations(id),
  space_id            TEXT NOT NULL REFERENCES spaces(id),
  provider_channel_id TEXT NOT NULL,
  transport           TEXT NOT NULL,
  plain_id            TEXT,                  -- номер канала компании (не клиента)
  state               TEXT NOT NULL DEFAULT 'unknown', -- состояние от провайдера
  state_changed_at    BIGINT,
  owner_user_id       TEXT REFERENCES users(id), -- NULL = канал пула
  is_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  UNIQUE (integration_id, provider_channel_id)
);

CREATE TABLE IF NOT EXISTS messenger_chats (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES messenger_channels(id),
  chat_type       TEXT NOT NULL,
  chat_id         TEXT NOT NULL,             -- pii: у WhatsApp — цифры номера клиента
  client_id       TEXT REFERENCES clients(id),
  last_inbound_at BIGINT,
  last_message_at BIGINT,
  awaiting_reply  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL,
  UNIQUE (channel_id, chat_type, chat_id)
);
CREATE INDEX IF NOT EXISTS messenger_chats_client_idx ON messenger_chats (client_id);

CREATE TABLE IF NOT EXISTS messenger_messages (
  id                  TEXT PRIMARY KEY,
  integration_id      TEXT NOT NULL REFERENCES integrations(id),
  chat_ref            TEXT NOT NULL REFERENCES messenger_chats(id),
  provider_message_id TEXT NOT NULL,
  direction           TEXT NOT NULL CONSTRAINT messenger_messages_direction_check CHECK (direction IN ('in','out')),
  msg_type            TEXT NOT NULL,
  body                TEXT,                  -- pii: текст сообщения
  has_attachment      BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT,
  author_user_id      TEXT REFERENCES users(id),
  is_edited           BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at             BIGINT NOT NULL,
  status_at           BIGINT,
  created_at          BIGINT NOT NULL,
  UNIQUE (integration_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messenger_messages_chat_idx ON messenger_messages (chat_ref, sent_at);
