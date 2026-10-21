# Архитектура CRM отдела продаж

Статус: **итоговый дизайн architect от 20.10.2026, ред. 2 после ревью**.
Решения со статусом «принято» в `docs/DECISIONS.md` обязательны. Решения
«предложено» действуют как значения по умолчанию, пока владелец не ответит
(`docs/PLAN.md` §9). График, уровни задач и гейты — только в `docs/PLAN.md`.

Связанные документы:
- `docs/PROCESS.md` — логика процессов (состояния, итоги, раздача, запись, права);
- `docs/CONFIG.md` — все настройки, формат пресета, кто и как меняет;
- `docs/INTEGRATIONS.md` — телефония, Wazzup, API приёма лидов, секреты;
- `docs/DECISIONS.md` — журнал решений.

Все имена, компании и номера в примерах выдуманы, номера вида +7 709 …

---

## 1. Синтез вариантов A и B

Вариант A («срок прежде всего») и вариант B («продукт прежде всего») совпадают
в основе: клиент общий на установку, работа отдела — карточка с `space_id`,
поведение итогов в коде, подписи в настройках, скоуп доступа в SQL, манифест
изоляции, офлайн-очередь итогов с ID с устройства, Docker-образы без исходников,
лицензия Ed25519. Расходятся в девяти местах.

Критерии: (1) без багов к 1.11, (2) тираж без правки кода, (3) безопасность
доступа и ПДн, (4) защита кода и лицензия, (5) поддержка одним разработчиком с
ИИ-агентами.

| Тема | A | B | Взяли | Почему (номера критериев) |
|---|---|---|---|---|
| Хранение настроек | таблицы `settings`, `dict_items`, `field_defs`, `roles` | один JSON-документ `ConfigV1` с ревизиями | **B**, упрощённо: без `config_origin`, вместо него в ревизии пресета хранится собранный пресет | (2) пресет = экспорт = откат, миграции настроек — чистые функции; (1) одна Zod-схема и один загрузчик проще четырёх CRUD; (5) атомарная смена «итог + причины + поля» |
| Кастомные поля | `custom jsonb` + таблица `field_defs` | `custom jsonb` + определения в конфигурации + `buildFieldValidator`/`projectFor` | **B** | (3) скрытое поле не покидает сервер ни через ответ, ни через фильтр; (2) одна проверка на все пути записи |
| Права | `dataScope: own/all` + отношения | каталог разрешений в коде + охваты `own/team/space/all` + отношения | **B**, с механикой A: предикат в `UPDATE`, 404/409, `SystemActor` только в задачах | (3) граница по охвату, не по имени роли; PROCESS 8.1 уже требует четыре охвата |
| Прогон изоляции | пресет ЦРП | пресет ЦРП **и** `base` | **B** | (3) изоляция не зависит от имён ролей |
| Где лежит ценная логика | слои `platform/core/integrations/ui` | отдельный пакет `packages/core` | **B** (пакет чистой логики) + **A** (слои сервера и правила импорта) | (4) обфусцируется один файл без Next; (1) сборку Next 16 не трогаем; (5) ядро тестируется без БД |
| Обфускация | весь серверный бандл Next | только `@crm/core` | **B** | (1) обфускация `.next/server` может сломать RSC и server actions; (4) ценная логика всё равно в ядре |
| Доставка образов | приватный GHCR, токен на сервере клиента | подписанный пакет `.tar.zst` на клиента | **B**; реестр — после 3–5 клиентов | (4) root клиента не получает доступ к реестру и чужим водяным знакам; (3) работает без выхода в интернет |
| Интеграции | порты `TelephonyAdapter`, `MessengerProvider`, таблицы на провайдера | общий контракт плагина, `webhook_inbox`, секреты AES-256-GCM с `kid` | **B** (контракт, inbox, секреты) + **A** (методы телефонии и мессенджера) | (2) новый провайдер = новый файл; (3) одна проверенная точка приёма вебхуков |
| Пресет ЦРП | `presets/clients/crp/` в репозитории продукта | приватный репозиторий поставок `crm-deploy` | **B**, до ответа владельца — временно `presets/clients/crp/` | (2) продукт не знает о клиентах |
| Фоновые задачи | воркер, слоты, `job_runs`, полный список задач | то же короче | **A** | (1) расписание из одного источника, двойной запуск невозможен |
| Отмена итога | на устройстве: итог ждёт 5 с в очереди | — | **A**; PROCESS P-06 (отмена на сервере) заменён | (1) на сервере нет кода компенсаций; (5) меньше состояний |
| Лимиты входа | в памяти, один процесс (D-018 crp-kz) | в БД (путь к SaaS) | **A** | (5) копия проверенного кода; SaaS не в рамках 1.11 |
| API приёма | `/batches`, отчёт счётчиками, `demand` по дням | `/leads`, скрытые ключи CLI | **A** (идемпотентность, `demand`) + **B** (скрытые ключи, путь) + PROCESS (статус каждой записи) | (2) один контракт для любых источников; рамка 4: в UI нет следов парсера |
| Лицензия | состояния `valid → expiring → expired → read_only` | формат, `kid`, монотонные часы, `invalid`, мягкие `seats` | **B** | (4) защита от перевода часов, ротация ключа |
| Стенд | на той же ВМ | не уточнено | отдельный сервер с синтетикой (вопрос владельцу) | (3) ночные сборки не лежат у root клиента; (4) |
| Телеметрия | healthcheck в Telegram | по умолчанию нет | **B** + технический healthcheck по договору | (3) |
| Состояния карточки | 5 стадий SalemAI + вид закрытия | 5 стадий + поведения | **ни A, ни B: PROCESS** — 9 явных состояний и 7 видов итога | (1) проще запросы и отчёты; нет двух копий логики (TS и SQL) |

Итог: каркас, график, фоновые задачи, офлайн и порядок резки — из A.
Фундамент, который дорого переделывать у следующих клиентов (документ
настроек, движок полей, каталог прав, пакет ядра, контракт плагинов,
подписанный пакет поставки), — из B. Добавка к объёму A — около 2,5 агенто-дня.

---

## 2. Модули и границы

### 2.1. Слои

| Слой | Каталог | Что внутри | Может импортировать | Нельзя |
|---|---|---|---|---|
| Ядро | `packages/core/src/` | чистые функции без БД и без Next: машина состояний карточки, правило повторов, рабочий календарь, номера РК, нормализация названий, сопоставление дублей, план раздачи, разбор таблиц, слоты, подбор консультанта, статусы записи, схема `ConfigV1` и её миграции, проверка целостности настроек, движок полей, каталог прав и валидатор ролей, проверка лицензии, водяной знак | только себя и `zod` | `postgres`, `next/*`, `node:fs`, `src/**` |
| Платформа сервера | `src/server/platform/` | БД и миграции, сессии, лимиты, аудит, хранилище настроек, планировщик, уведомления, секреты, флаги, окружение, файлы, i18n сервера | ядро, npm | `next/*` (кроме `src/server/platform/http/`), `src/server/domain`, `src/integrations` |
| Домен сервера | `src/server/domain/<модуль>/` | репозитории с SQL и сервисы: клиенты, карточки, звонки, раздача, приём, импорт, запись, сделки, передачи, задачи, лента, отчёты, выгрузки | ядро, платформа, интерфейсы `src/integrations/contract.ts` | `next/*`, конкретные плагины |
| Доступ | `src/server/access/` | `Viewer`, `scopeSql`, обёртки `route()`, `page()`, `action()`, `SystemActor` | ядро, платформа | — |
| Интеграции | `src/integrations/` | контракт плагина, реестр, плагины `telephony.*`, `messenger.*` | ядро, платформа | друг друга, домен |
| Интерфейс | `src/app/`, `src/ui/` | маршруты Next, страницы, route handlers, server actions, компоненты, оболочки по ролям | всё серверное — только из серверных файлов | SQL напрямую, `@crm/core` из клиентских компонентов, `SystemActor` |
| Процессы | `scripts/worker.ts`, `scripts/crmctl/` | воркер и CLI | ядро, платформа, домен, интеграции, `SystemActor` | `next/*` |

Правила проверяют ESLint `no-restricted-imports` и статический тест
`tests/unit/layers.test.ts` (обход импортов). Нарушение роняет CI.

### 2.2. Границы, важные для безопасности

- Данные читаются и пишутся **только** через `src/server/domain/*/repo.ts`.
  Первый аргумент любой функции репозитория — `viewer: Viewer` или
  `actor: SystemActor`.
- `SystemActor` импортируется только из `scripts/**` и `src/server/jobs/**`.
  Статический тест ищет импорт в `src/app/**` и роняет CI.
- Клиентские компоненты не получают из сервера ничего, кроме проекции
  `projectFor(viewer, …)`. Правильных ответов, скрытых полей, чужих имён в
  уведомлениях нет.
- Парсер ЦРП в продукт не входит. В коде нет ни слова о нём: только общий API
  приёма `ingest/v1` (`docs/INTEGRATIONS.md` §5).

### 2.3. Модули домена

| Модуль | Что делает | Источник логики |
|---|---|---|
| `clients` | клиенты, контакты, телефоны, поля, поиск, слияние, обезличивание | PROCESS 1, 2.3, 12.20; слияние — логика SalemAI |
| `cards` | карточки, применение итога, пропуски, возвраты, «Вернуть в обзвон», «Не звонить» | PROCESS 3; ядро `calling/` |
| `calls` | приём итогов (онлайн и офлайн), журнал звонков, счётчики | PROCESS 2.5, 12.1–12.8 |
| `distribution` | пул, авто и ручная раздача, лимит, пары, «Отсутствует», «Пауза», журнал | PROCESS 7; ядро `distribution/` |
| `intake` | приём по API, дедуп, стоп-лист, «Предложить контакт», ручное создание | PROCESS 2.2–2.3; INTEGRATIONS §5 |
| `import` | загрузка CSV/XLSX, профиль, предпросмотр, применение, очистка | PROCESS 2.2, 3.7 |
| `booking` | серии, мероприятия, ресурсы (консультанты), записи, «серые», явка, напоминания | PROCESS 5; ядро `booking/` |
| `deals` | воронки, сделки, канбан, покупки, отмена покупки | PROCESS 4 |
| `handoffs` | передача в отдел, приём, тревога | PROCESS 2.8, 6.2 |
| `tasks` | задачи, комментарии, автозадачи по `source_key` | PROCESS 6 |
| `timeline` | лента клиента и сделки, итоговый отчёт по клиенту | PROCESS 9 |
| `reports` | сводка РОП, отчёты, панель директора, выгрузки с журналом | PROCESS 10 |
| `team` | сотрудники, приглашения, отключение с передачей дел | PROCESS 8, 12.15 |
| `notify` | колокол, push, утренняя сводка, тревоги | PROCESS 11 |
| `admin` | настройки, лицензия, состояние сервера; полная выгрузка — по разрешению `data.export_all` (D-055) | CONFIG.md |

---

## 3. Структура каталогов

```
crp-crm-/
  AGENTS.md  CLAUDE.md  README.md
  docs/  ARCHITECTURE.md  PROCESS.md  CONFIG.md  INTEGRATIONS.md  DECISIONS.md
         agents/ROUTING.md          # копия из crp-kz
         ops/RUNBOOK.md             # установка, обновление, откат, бэкап, восстановление
  packages/core/                    # @crm/core: чистая логика, собирается и обфусцируется отдельно
    src/ calling/ time/ phone/ names/ dedup/ distribution/ import/ booking/
         config/ (schema/v1.ts, merge.ts, migrations/, integrity.ts)
         fields/ access/ (catalog.ts, roleValidator.ts) license/ watermark.ts
    package.json  build.mjs         # esbuild → dist/index.mjs → javascript-obfuscator
  presets/
    base/preset.json                # продукт по умолчанию: типы и значения по умолчанию
    kz/preset.json                  # страновой слой: праздники и переносы РК, номера, формы собственности, пояс
    consulting-sales/preset.json    # отраслевой слой: групповые мероприятия + консультации
    # clients/crp/                  # временно, пока нет crm-deploy (PLAN §9 В-20); assets/ — логотип и шрифты
  migrations/  YYYY-MM-DD-<поток>-<slug>.sql   # после влития v1 — только новые файлы (D-059)
  messages/ru/<модуль>.json  messages/kk/<модуль>.json   # склеиваются при сборке; тест паритета
  src/
    server/
      platform/ db/ auth/ audit.ts config/ jobs/ notify/ secrets/ files/ flags.ts env.ts i18n/ http/
      access/   viewer.ts scope.ts wrappers.ts systemActor.ts
      domain/   clients/ cards/ calls/ distribution/ intake/ import/ booking/ deals/
                handoffs/ tasks/ timeline/ reports/ team/ notify/ admin/
      jobs/     registry.ts + по файлу на задачу
    integrations/ contract.ts registry.ts
      telephony/ manual/ beeline/ zadarma/
      messenger/ wa-link/ wazzup/
    ui/        kit/ (из crp-kz components/ui)  shells/ (OperatorShell, ManagerShell)  tokens.css
    shared/    клиентобезопасные помощники (формат дат, маска номера, ссылки tel: и wa.me до O6)
    proxy.ts   проверка Origin и заголовков; сессия проверяется в обёртках, не здесь
    app/       (op)/…  (mgr)/…  api/…  manifest.ts  sw.js в public/
  scripts/     worker.ts  crmctl/ (index.ts + по файлу на команду)
               license-sign.ts, release-sign.ts (запускает только владелец; ключей в репозитории нет)
  tests/       unit/ integration/<модуль>/ isolation/ e2e/ fixtures/ (синтетика +7 709 …)
  Dockerfile
  deploy/      compose.yml  nginx/  bin/ (install.sh, backup.sh, restore.sh, healthcheck.sh)
  .github/workflows/  ci.yml  release.yml
```

---

## 4. Модель данных

### 4.1. Правила

- id `TEXT` (UUID, выдаёт приложение). Время `BIGINT` epoch-мс. Деньги `BIGINT`
  в целых тенге (`amount_kzt`). Местные дата и время записи — `TEXT 'YYYY-MM-DD'`,
  `'HH:MM'` плюс `starts_at BIGINT`.
- Миграции `migrations/YYYY-MM-DD-<поток>-<slug>.sql`: идемпотентные
  (`IF NOT EXISTS`), только добавляющие, учёт в `schema_migrations` вместе с
  sha256 файла (изменённый применённый файл роняет `migrate` и CI; правка —
  только новым файлом, D-059), запуск под advisory lock, DDL выполняет роль
  `crm_owner` при выкладке. Приложение
  работает под `crm_app` (как D-026 crp-kz). Расширение закрытого списка `CHECK`
  считается добавляющей правкой (как D-037 crp-kz).
- Закрытые списки поведения (состояния, виды итогов, статусы) — `CHECK`. Ключи
  из настроек (код итога, причины, этапа, типа мероприятия, роли) — `TEXT` без
  `CHECK`: их проверяет приложение по текущей ревизии настроек. Ключ после
  создания не меняется, удаления нет, только архив.
- Колонки `tenant_id` нет: одна компания = одна установка = своя БД.
- ПДн, которые не нужны в открытом виде, не хранятся открыто: ИИН — HMAC (в
  том числе 12 цифр у ИП, D-052), стоп-лист — HMAC номера. Ключи HMAC — в
  окружении, не в БД. Каждая колонка с ПДн помечена `-- pii` в миграции и
  стоит в реестре §4.6.
- Лента `client_events`, `audit_log`, `booking_history`, `consents` и
  `config_revisions` — только добавление: у `crm_app` нет `UPDATE` и `DELETE`;
  у `clients` нет `DELETE` (права — `deploy/postgres/grants.sql`, D-068).
  `DELETE` у `crm_app` есть **только** у служебных таблиц по явному списку в
  `grants.sql` (сессии, приглашения, очереди, purge, сменяемые настройки
  консультанта, стоп-лист для снятия «Не звонить»); у остальных — нет, и у
  таблиц из будущих миграций по умолчанию тоже нет. Звонки, сделки, карточки,
  записи, задачи, сотрудники не удаляются даже ошибкой репозитория.
  Слияние эти таблицы не переписывает: данные слитого клиента читаются по
  цепочке `merged_into_id`. Обезличивание чистит ленту функцией
  `depersonalize_client(id)` с `SECURITY DEFINER` от `crm_owner` — она
  приходит отдельной миграцией вместе с B9 (D-069).

### 4.2. Где `space_id`

Клиент (`clients`) общий на установку. Работа отдела с клиентом — карточка
(`cards`, одна на пару «пространство, клиент»). `space_id NOT NULL` есть у:
`cards`, `calls`, `memberships`, `teams`, `absences`, `assign_log`, `skips`,
`proposals`, `imports`, `event_series`, `events`, `resources`, `bookings`,
`deals`, `tasks`, `notes`, `client_events`, `config_revisions` (через `scope`).
`handoffs` несут `space_id_from` и `space_id_to`. В интерфейсе пока одно
пространство «Продажи», переключатель скрыт.

### 4.3. DDL-эскиз ключевых таблиц

Эскиз для architect при написании миграций. Окончательный SQL пишет architect
(T2), builder не меняет ограничения без записи в `docs/DECISIONS.md`.
**Окончательный SQL v1 — `migrations/2026-10-21-platform-schema-v1.sql`**,
карта таблиц — `docs/schema-v1.md`. Эскиз ниже уточнён решениями
D-067…D-070 (внешние ключи на все ссылки, `custom` у контактов и записей,
приглашение без роли и др.); при расхождении эскиза с файлом действует файл.

```sql
-- ===== Платформа =====
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone_digits  TEXT NOT NULL,                 -- 7XXXXXXXXXX, вход по номеру
  name          TEXT NOT NULL,
  password_hash TEXT,                          -- NULL до принятия приглашения
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,-- права установки, не данные клиентов
  locale        TEXT NOT NULL DEFAULT 'ru',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at BIGINT NOT NULL, last_login_at BIGINT, disabled_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uq ON users (phone_digits);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,               -- sha256(токен); сам токен только в cookie
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_default ON spaces ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, phone_digits TEXT NOT NULL,
  space_id TEXT REFERENCES spaces(id), role_key TEXT NOT NULL DEFAULT '', team_id TEXT, -- оба пусты или оба заданы (D-070)
  kind TEXT NOT NULL DEFAULT 'invite' CHECK (kind IN ('invite','reset')),
  expires_at BIGINT NOT NULL, used_at BIGINT, created_by TEXT, created_at BIGINT NOT NULL -- created_by NULL: CLI
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), key TEXT NOT NULL,
  lead_user_id TEXT REFERENCES users(id), archived_at BIGINT, UNIQUE (space_id, key)
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id   TEXT NOT NULL REFERENCES users(id),
  space_id  TEXT NOT NULL REFERENCES spaces(id),
  role_key  TEXT NOT NULL,                     -- роль из настроек; одна роль в пространстве
  team_id   TEXT REFERENCES teams(id),
  in_distribution BOOLEAN NOT NULL DEFAULT FALSE,
  paused_on TEXT NOT NULL DEFAULT '',          -- 'YYYY-MM-DD': «Пауза» на этот день
  status    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, space_id)
);

CREATE TABLE IF NOT EXISTS absences (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  from_day TEXT NOT NULL, to_day TEXT NOT NULL,          -- включительно, местные даты
  substitute_user_id TEXT REFERENCES users(id),           -- NULL = поровну между работающими
  created_by TEXT, created_at BIGINT NOT NULL, cancelled_at BIGINT,   -- created_by NULL: система
  CHECK (from_day <= to_day)
);
CREATE INDEX IF NOT EXISTS absences_user_idx ON absences (space_id, user_id, from_day);

CREATE TABLE IF NOT EXISTS config_revisions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                         -- 'global' или id пространства
  rev INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  doc JSONB NOT NULL,
  hash TEXT NOT NULL,                          -- sha256 канонического JSON
  source TEXT NOT NULL CHECK (source IN ('preset','ui','cli','migration','rollback')),
  preset_doc JSONB,                            -- собранный пресет при source='preset'
  note TEXT NOT NULL DEFAULT '', author_id TEXT, created_at BIGINT NOT NULL,
  UNIQUE (scope, rev)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY, job TEXT NOT NULL, slot_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  attempt INTEGER NOT NULL DEFAULT 1, started_at BIGINT NOT NULL, finished_at BIGINT,
  stats JSONB NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '',
  UNIQUE (job, slot_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, entity_type TEXT NOT NULL DEFAULT '', entity_id TEXT NOT NULL DEFAULT '',
  params JSONB NOT NULL DEFAULT '{}',          -- только коды, числа и id
  dedupe_key TEXT, not_before BIGINT NOT NULL, -- тихие часы: push не раньше
  created_at BIGINT NOT NULL, read_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
-- push_subscriptions(endpoint UNIQUE), push_outbox(state, attempts, next_at; SKIP LOCKED) — по образцу crp-kz mail/outbox

CREATE TABLE IF NOT EXISTS license_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  license_raw TEXT NOT NULL DEFAULT '', install_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('valid','expiring','expired','read_only','invalid','missing')),
  last_seen_at BIGINT NOT NULL,                -- максимум виденного «сейчас» лицензии (правило часов §8.4)
  checked_at BIGINT NOT NULL
);
-- + invalid_since, reason (D-214); clock_real_at, clock_behind_since, clock_behind_last — часы позади (D-306)
-- audit_log: как в crp-kz + space_id; у crm_app только INSERT и SELECT

-- ===== Клиенты =====
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('company','person')),
  name TEXT NOT NULL, name_norm TEXT NOT NULL,
  legal_form TEXT NOT NULL DEFAULT '',         -- код из org.legalForms
  org_id TEXT NOT NULL DEFAULT '',             -- БИН (правило org.idRule), '' если нет; у ИП ('idIsPersonal') всегда ''
  iin_hmac TEXT,                               -- ИИН только HMAC (у ИП — их 12 цифр)
  region TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
  custom JSONB NOT NULL DEFAULT '{}',          -- значения полей из настроек
  search_norm TEXT NOT NULL DEFAULT '',        -- название + номера + поля searchable
  source_kind TEXT NOT NULL CHECK (source_kind IN ('import','ingest','manual','proposal','messenger','telephony','walk_in')),
  source_key TEXT NOT NULL DEFAULT '',         -- подпись берётся из sources.<key>.label
  merged_into_id TEXT REFERENCES clients(id),
  depersonalized_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_org_uq  ON clients (org_id)   WHERE org_id <> '' AND merged_into_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS clients_iin_uq  ON clients (iin_hmac) WHERE iin_hmac IS NOT NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS clients_search_trgm ON clients USING GIN (search_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS clients_custom_gin  ON clients USING GIN (custom jsonb_path_ops);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '',
  is_decision_maker BOOLEAN NOT NULL DEFAULT FALSE, call_hint TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', custom JSONB NOT NULL DEFAULT '{}',  -- поля объекта contact (D-070)
  created_at BIGINT NOT NULL, archived_at BIGINT
);

CREATE TABLE IF NOT EXISTS client_phones (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
  contact_id TEXT REFERENCES contacts(id),
  digits TEXT NOT NULL, ext TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('mobile','landline','unknown')),
  is_working BOOLEAN NOT NULL DEFAULT TRUE, is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  has_whatsapp TEXT NOT NULL DEFAULT 'unknown' CHECK (has_whatsapp IN ('yes','no','unknown')),
  created_at BIGINT NOT NULL,
  UNIQUE (client_id, digits)                   -- глобально номер не уникален: общий бухгалтер — норма
);
CREATE INDEX IF NOT EXISTS client_phones_digits_idx  ON client_phones (digits);
CREATE INDEX IF NOT EXISTS client_phones_digits_trgm ON client_phones USING GIN (digits gin_trgm_ops); -- поиск по 5+ цифрам

CREATE TABLE IF NOT EXISTS stop_list (
  phone_hmac TEXT PRIMARY KEY,                 -- HMAC номера: переживает слияние и обезличивание
  reason_code TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('outcome','manual','depersonalize','import')),
  created_by TEXT, created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_sources (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id),
  source_kind TEXT NOT NULL, source_key TEXT NOT NULL DEFAULT '',
  ingest_key_id TEXT, import_id TEXT,
  external_id TEXT, first_seen_at BIGINT NOT NULL
);
-- уникальность по источнику, а не по ключу: ротация ключа не ломает узнавание externalId
CREATE UNIQUE INDEX IF NOT EXISTS client_sources_ext_uq ON client_sources (source_key, external_id)
  WHERE source_key <> '' AND external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dup_pairs (
  id TEXT PRIMARY KEY, a_client_id TEXT NOT NULL, b_client_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('shared_phone','name_and_head')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','distinct','split_allowed')),
  comment TEXT NOT NULL DEFAULT '', resolved_by TEXT, resolved_at BIGINT, created_at BIGINT NOT NULL,
  CHECK (a_client_id < b_client_id), UNIQUE (a_client_id, b_client_id, reason)
);

-- ===== Карточки и звонки =====
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  owner_user_id  TEXT REFERENCES users(id),     -- NULL = пул
  acting_user_id TEXT REFERENCES users(id),     -- временный владелец («Отсутствует»)
  acting_until_day TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN
    ('new','retry','callback','agreed','client','not_interested','not_target','do_not_call','written_off')),
  hold_reason TEXT NOT NULL DEFAULT '' CHECK (hold_reason IN ('','dup_pair','import_conflict','no_working_phone','rule')),
  hold_code TEXT NOT NULL DEFAULT '',           -- код правила задержки из настроек
  attempts INTEGER NOT NULL DEFAULT 0,          -- недозвоны подряд
  next_call_at BIGINT, return_at BIGINT,
  lpr TEXT NOT NULL DEFAULT '' CHECK (lpr IN ('','yes','no')),
  is_target TEXT NOT NULL DEFAULT '' CHECK (is_target IN ('','yes','no')),
  last_outcome_code TEXT NOT NULL DEFAULT '', last_outcome_kind TEXT NOT NULL DEFAULT '',
  last_outcome_at BIGINT,                       -- occurred_at последнего применённого итога
  close_reason_code TEXT NOT NULL DEFAULT '', closed_at BIGINT,
  assigned_at BIGINT,
  touched_in_crm BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE после итога или ручного действия с состоянием в CRM; раздача, передача и импорт не ставят (D-145)
  calls_total INTEGER NOT NULL DEFAULT 0, connects_total INTEGER NOT NULL DEFAULT 0,
  no_answer_total INTEGER NOT NULL DEFAULT 0,
  first_connect_at BIGINT, last_connect_at BIGINT, last_touch_at BIGINT,
  custom JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  UNIQUE (space_id, client_id)
);
CREATE INDEX IF NOT EXISTS cards_queue_idx  ON cards (space_id, owner_user_id, state, next_call_at);
CREATE INDEX IF NOT EXISTS cards_acting_idx ON cards (space_id, acting_user_id) WHERE acting_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cards_pool_idx   ON cards (space_id, created_at)
  WHERE owner_user_id IS NULL AND state = 'new' AND hold_reason = '';
CREATE INDEX IF NOT EXISTS cards_hold_idx   ON cards (space_id, hold_reason) WHERE hold_reason <> '';
CREATE INDEX IF NOT EXISTS cards_return_idx ON cards (space_id, return_at) WHERE state = 'not_interested';

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,                          -- opId с устройства; повтор = ON CONFLICT DO NOTHING
  space_id TEXT NOT NULL, card_id TEXT NOT NULL REFERENCES cards(id), client_id TEXT NOT NULL,
  user_id TEXT, owner_user_id_at_call TEXT,   -- user_id NULL только при via import/telephony
  direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
  via TEXT NOT NULL CHECK (via IN ('ui','offline','import','telephony','manual_entry')),
  phone_digits TEXT NOT NULL DEFAULT '',
  outcome_code TEXT NOT NULL,                   -- ключ итога из настроек
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN
    ('no_answer','bad_number','callback','agreed','not_interested','not_target','do_not_call')),
  reason_code TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  lpr TEXT NOT NULL DEFAULT '' CHECK (lpr IN ('','yes','no')),
  callback_at BIGINT, fields_patch JSONB NOT NULL DEFAULT '{}',
  applied TEXT NOT NULL CHECK (applied IN ('applied','fact_only')),
  fact_reason TEXT NOT NULL DEFAULT '' CHECK (fact_reason IN ('','owner_changed','stale')),
  tapped_at BIGINT, occurred_at BIGINT NOT NULL, received_at BIGINT NOT NULL,
  duration_sec INTEGER,
  duration_source TEXT NOT NULL DEFAULT 'none' CHECK (duration_source IN ('none','manual_estimate','provider')),
  telephony_call_id TEXT,
  import_key TEXT,                              -- ключ строки + ключ состояния (D-048)
  config_rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_import_uq ON calls (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_card_idx  ON calls (card_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS calls_stats_idx ON calls (space_id, user_id, occurred_at) WHERE via <> 'import';

CREATE TABLE IF NOT EXISTS assign_log (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, card_id TEXT NOT NULL,
  from_user_id TEXT, to_user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual','return','absence','release','transfer','inbound','proposal','merge')),
  counts_to_cap BOOLEAN NOT NULL,              -- по distribution.capIncludes на момент выдачи
  run_id TEXT, day TEXT NOT NULL,              -- местные сутки
  actor_id TEXT, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assign_cap_idx ON assign_log (space_id, to_user_id, day) WHERE counts_to_cap;
CREATE INDEX IF NOT EXISTS assign_day_idx ON assign_log (space_id, day);

CREATE TABLE IF NOT EXISTS skips (
  id TEXT PRIMARY KEY,                          -- opId: повтор не считается дважды
  space_id TEXT NOT NULL, user_id TEXT NOT NULL, card_id TEXT NOT NULL,
  day TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS skips_day_idx ON skips (user_id, day);

-- proposals («Предложить контакт»), imports, import_rows (строки ПДн удаляются через 14 дней), notes — см. 4.4

CREATE TABLE IF NOT EXISTS client_events (      -- лента: только добавление
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, space_id TEXT NOT NULL,
  deal_id TEXT, kind TEXT NOT NULL,            -- 'call','call.voided','booking.created','deal.stage',...
  actor_id TEXT, at BIGINT NOT NULL,
  ref_type TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}'             -- коды, id, числа; значения полей — только для полей с access
);
CREATE INDEX IF NOT EXISTS client_events_feed_idx ON client_events (client_id, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS client_events_deal_idx ON client_events (deal_id, at DESC) WHERE deal_id IS NOT NULL;

-- ===== Запись =====
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, series_id TEXT,
  event_type_key TEXT NOT NULL,                -- у ЦРП 'br'
  event_date TEXT NOT NULL, start_time TEXT NOT NULL, starts_at BIGINT NOT NULL,
  duration_min INTEGER NOT NULL, location TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  occurrence_key TEXT, touched BOOLEAN NOT NULL DEFAULT FALSE,   -- ручная правка: генерация не трогает
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_occurrence_uq ON events (occurrence_key) WHERE occurrence_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_time_idx ON events (space_id, starts_at);
-- event_series, event_duty(event_id, user_id PK), resources, resource_schedule, resource_exceptions — см. 4.4

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('group','individual')),
  event_type_key TEXT NOT NULL,
  event_id TEXT REFERENCES events(id), resource_id TEXT,         -- resource_id NULL у «серой»
  client_id TEXT NOT NULL, card_id TEXT NOT NULL, deal_id TEXT, contact_id TEXT,
  booking_date TEXT NOT NULL, start_time TEXT NOT NULL, starts_at BIGINT NOT NULL, duration_min INTEGER NOT NULL,
  direction_key TEXT NOT NULL DEFAULT '', is_reserve BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN
    ('registered','confirmed','attended','no_show','cancelled','moved')),
  cancel_reason TEXT NOT NULL DEFAULT '',      -- 'client','event_cancelled','operator_error','do_not_call'
  booked_by_user_id TEXT,                      -- заслуга (не меняется при передаче); NULL: импорт, система
  responsible_user_id TEXT,                    -- ответственный (меняется при передаче)
  moved_from_id TEXT, moved_to_id TEXT, grey_processed_at BIGINT,
  custom JSONB NOT NULL DEFAULT '{}',          -- поля объекта booking (D-070)
  via TEXT NOT NULL DEFAULT 'ui' CHECK (via IN ('ui','import','walk_in')), import_key TEXT, -- профиль «Записи», гость без записи
  request_id TEXT, version INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  CHECK (kind <> 'group' OR event_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_group_uq ON bookings (event_id, client_id)
  WHERE kind = 'group' AND status IN ('registered','confirmed','attended','no_show');
CREATE UNIQUE INDEX IF NOT EXISTS bookings_request_uq ON bookings (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_event_idx    ON bookings (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_resource_idx ON bookings (resource_id, booking_date);
CREATE INDEX IF NOT EXISTS bookings_resp_idx     ON bookings (space_id, responsible_user_id, starts_at);
CREATE INDEX IF NOT EXISTS bookings_grey_idx     ON bookings (space_id, booking_date)
  WHERE kind = 'individual' AND resource_id IS NULL AND status IN ('registered','confirmed');

-- ===== Сделки, передачи, задачи =====
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
  pipeline_key TEXT NOT NULL, stage_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','won','lost')),  -- копия вида этапа: отчёты не зависят от настроек
  client_id TEXT NOT NULL, card_id TEXT NOT NULL, owner_user_id TEXT,
  service_type_key TEXT NOT NULL DEFAULT '', amount_kzt BIGINT NOT NULL DEFAULT 0 CHECK (amount_kzt >= 0),
  won_at BIGINT, lost_at BIGINT, lost_reason_code TEXT NOT NULL DEFAULT '',
  needs_rebook BOOLEAN NOT NULL DEFAULT FALSE, stage_changed_at BIGINT NOT NULL,
  custom JSONB NOT NULL DEFAULT '{}', request_id TEXT, version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL  -- created_by NULL: система
);
CREATE UNIQUE INDEX IF NOT EXISTS deals_request_uq ON deals (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_board_idx  ON deals (space_id, pipeline_key, status, stage_key);
CREATE INDEX IF NOT EXISTS deals_client_idx ON deals (client_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, space_id_from TEXT NOT NULL, space_id_to TEXT NOT NULL,
  team_id TEXT NOT NULL, deal_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled')),
  assignee_user_id TEXT, due_at BIGINT NOT NULL, accepted_at BIGINT, accepted_by TEXT,
  declined_reason TEXT NOT NULL DEFAULT '', alarm_sent_at BIGINT, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS handoffs_inbox_idx ON handoffs (team_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, client_id TEXT NOT NULL, deal_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('call','message','meeting','handoff','check','other')),
  source TEXT NOT NULL CHECK (source IN ('manual','callback','no_show','rebook','inbound_message',
    'missed_call','handoff','grey_unassigned','dnc_inbound','review','proposal',
    'attendance_mark','next_step','agreement','clarify_import','absent_review')),
  title TEXT NOT NULL, due_at BIGINT, assignee_user_id TEXT, team_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  source_key TEXT,                             -- автозадача не задваивается: одна открытая на ключ
  created_by TEXT, done_at BIGINT, created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_source_uq ON tasks (source_key) WHERE source_key IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_user_id, status, due_at);
CREATE INDEX IF NOT EXISTS tasks_client_idx   ON tasks (client_id) WHERE status = 'open';

-- ===== Интеграции и приём =====
CREATE TABLE IF NOT EXISTS ingest_keys (
  id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL,  -- sha256 секрета
  space_id TEXT NOT NULL, source_key TEXT NOT NULL,
  scopes TEXT[] NOT NULL,                      -- 'leads:write','leads:demand'
  managed TEXT NOT NULL CHECK (managed IN ('ui','cli')),  -- 'cli' в интерфейсе не показывается
  created_at BIGINT NOT NULL, last_used_at BIGINT, revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS ingest_batches (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES ingest_keys(id), source_key TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, report JSONB NOT NULL,      -- только счётчики и статусы по externalId
  received_at BIGINT NOT NULL, UNIQUE (source_key, batch_id)  -- удаляются через 30 дней (D-056)
);
CREATE TABLE IF NOT EXISTS webhook_inbox (
  id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL, payload JSONB,           -- ПДн: обнуляется через 14 дней
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at BIGINT NOT NULL, error TEXT NOT NULL DEFAULT '',
  received_at BIGINT NOT NULL, processed_at BIGINT,
  UNIQUE (integration_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS webhook_inbox_pending_idx ON webhook_inbox (state, next_at) WHERE state = 'pending';
-- integrations, integration_secrets, messenger_* — docs/INTEGRATIONS.md, в схеме v1 (D-069);
-- telephony_*, call_intents, call_recordings — отдельной миграцией с первым живым адаптером (INTEGRATIONS §2.7)
```

### 4.4. Остальные таблицы (кратко)

| Таблица | Ключевые колонки и ограничения |
|---|---|
| `proposals` | space_id, user_id, digits, name, status (`created`, `review`, `rejected`), matched_client_id; индекс `(user_id, created_at)` для лимита в день |
| `imports` | space_id, file_name, file_sha256, profile_key, status (`preview`, `applied`, `failed`), report jsonb (только счётчики), created_by; файл не хранится |
| `import_rows` | import_id, row_no, import_key, parsed jsonb, issue, client_id; удаляются задачей `purge` через 14 дней |
| `notes` | client_id, space_id, deal_id, author_id, body, pinned, edited_at |
| `task_comments` | task_id, author_id, body |
| `event_series` | space_id, event_type_key, weekday 1–7, start_time, duration_min, location, format, capacity, active |
| `event_duty` | PK(event_id, user_id) |
| `resources` | space_id, user_id, directions TEXT[] (ключи), slot_min, capacity, auto_assign, active, sort |
| `resource_schedule`, `resource_exceptions` | недельный график с перерывами; исключения по датам (`off`, `custom`) |
| `booking_history` | booking_id, action, from_status, to_status, actor_id, meta; только добавление |
| `integrations` | id, plugin_id, space_id (NULL = вся установка), config jsonb без секретов, enabled, status, `webhook_token_hash` (UNIQUE, sha256 токена из пути, §4 INTEGRATIONS), last_event_at, crossborder_approved_at/by |
| `integration_secrets` | PK(integration_id, name), kid, iv, ciphertext, tag (AES-256-GCM), last4 для UI |
| `consents` | client_id, kind (`messenger_crossborder`, `call_recording`), action (`given`, `revoked`), at, text_hash (как D-035 crp-kz), recorded_by; только добавление, отзыв — новой строкой `revoked` |
| `device_status` | PK(user_id, device_id), pending_outbox, last_flush_at, seen_at; без ПДн (D-063) |
| `change_snapshots` | operation_id, kind (`merge`, `bulk_transfer`), table_name, row_id, client_id (для обезличивания), before jsonb, created_by, created_at; чистится через 30 дней (D-062) |
| `phone_probes` | user_id, day, path (`proposal`, `add_phone`, `walk_in`, `manual_create`), matched; счётчик `security.phoneProbesPerDay` (D-040) |
| `push_subscriptions`, `push_outbox` | подписка: endpoint UNIQUE, ключи, device_id; очередь: строка на пару «уведомление, подписка» (UNIQUE), state, attempts, next_at, lease_until; текст без ПДн (D-033) |
| `messenger_channels`, `messenger_chats`, `messenger_messages` | DDL — INTEGRATIONS §3.2, в v1 с FK и `space_id` (D-069) |

### 4.5. Гарантии уникальности и порядка

| Что защищаем | Чем |
|---|---|
| Дубль компании | `UNIQUE(org_id)`, `UNIQUE(iin_hmac)`; номер + название через ядро `dedup`; спорное — в `dup_pairs` («ложная склейка хуже дубля») |
| Два приёма одного номера одновременно | общая блокировка приёма `pg_advisory_xact_lock(hash('intake'))`: её берут все пути, создающие клиента (приём, импорт, ручное создание, «Предложить контакт», входящее сообщение или звонок). Объёмы малы, а гарантия сильнее, чем блокировки по номерам |
| Повтор партии приёма | `UNIQUE(source_key, batch_id)` + `request_hash` (ротация ключа не ломает) |
| Повтор строки приёма | `UNIQUE(source_key, external_id)` |
| Повтор импорта | ключ строки = профиль + хэш опознающих полей (название, номера, руководитель), без имени файла; ключ состояния = хэш колонок итога, ЛПР, статуса, ниши, заметки; `UNIQUE(import_key)` в `calls`, `import_key` = ключ строки + ключ состояния (D-048) |
| Повтор итога, двойное нажатие | PK `calls.id` = opId |
| Два итога по карточке одновременно | `UPDATE … WHERE version = $v` (офлайн-итог — по `last_outcome_at`, раздел 7) |
| Двойная запись на мероприятие | частичный `UNIQUE(event_id, client_id)` |
| Последнее место на мероприятии | `SELECT … FOR UPDATE` строки `events` + пересчёт мест в транзакции |
| Слот консультанта | advisory lock по `(resource_id, booking_date)` + проверка слота в транзакции |
| Одна активная будущая запись клиента на тип | проверка под advisory lock по `client_id` в транзакции (индекс невозможен: «будущая» зависит от времени) |
| Повтор записи, покупки | `UNIQUE(request_id)` |
| Двойная автозадача, передача | `UNIQUE(source_key)` среди открытых задач, `UNIQUE(deal_id)` у `handoffs` |
| Повтор вебхука | `UNIQUE(integration_id, dedupe_key)` |
| Двойной запуск задачи | `UNIQUE(job, slot_key)` + `pg_try_advisory_lock` |
| Двойная сводка в 09:00 | `notifications.dedupe_key` = `digest:<user>:<дата>` |

### 4.6. Реестр ПДн и обезличивание (D-053)

Реестр — `src/server/domain/clients/piiRegistry.ts` (код) и эта таблица
(смысл). Каждая колонка с ПДн помечена в миграции `-- pii`; статический тест
`tests/unit/static-pii-registry.test.ts` сверяет пометки с этой таблицей в обе
стороны (а с `piiRegistry.ts` — когда файл появится, B9). Формат строки для
теста: в первой колонке — таблицы в обратных кавычках (несколько — только с
одинаковыми колонками), во второй — колонки в обратных кавычках (`pii` в
пояснении не считается); строка без
таблицы в кавычках (копии БД) и строки таблиц телефонии, которых ещё нет
(D-069), тест пропускает. `depersonalize_client(id)` (`SECURITY DEFINER`, от
`crm_owner`) обрабатывает **каждую** строку реестра в одной транзакции;
интеграционный тест создаёт клиента со всеми видами данных, обезличивает и
проверяет, что исходных значений нет ни в одной колонке реестра (по образцу
теста слияния «все ссылки перенесены»).

| Где | Колонки | Что делает обезличивание |
|---|---|---|
| `clients` | `name`, `name_norm`, `org_id`, `iin_hmac`, `address`, `email`, `website`, `custom` (поля с `pii`), `search_norm` | имя → «Обезличено», `iin_hmac` → NULL, остальное пусто; `depersonalized_at` |
| `cards` | `custom` (поля с `pii`) | пусто |
| `contacts` | `name`, `position`, `call_hint`, `note`, `custom` (поля с `pii`) | пусто |
| `client_phones` | `digits`, `ext` | номер → HMAC в `stop_list`, строка удаляется |
| `calls` | `phone_digits`, `note`, `fields_patch` | пусто; итог, время, вид остаются для отчётов |
| `notes`, `task_comments` | `body` | «Удалено по запросу» |
| `tasks` | `title` (может содержать имя) | заголовок по коду источника без имён |
| `client_events` | `data` (значения полей) | значения полей удаляются, коды и числа остаются |
| `bookings` | `custom` (поля с `pii`) | пусто |
| `deals` | `custom` (поля с `pii`), `lost_reason_text` | пусто |
| `handoffs` | `declined_reason` | пусто |
| `proposals` | `digits`, `name` | пусто |
| `import_rows` | `parsed` | строки клиента удаляются (и так живут 14 дней) |
| `webhook_inbox` | `payload` | обнуляется (и так через 14 дней) |
| `ingest_batches` | `report` (externalId записей) | externalId клиента в отчёте → пусто (и так 30 дней) |
| `change_snapshots` | `before` | строки клиента (`client_id`) удаляются (и так 30 дней) |
| `dup_pairs` | `comment` | пусто |
| `client_sources` | `external_id` | пусто (у источника «Новая база» — хэш БИН, но чистим тоже) |
| `messenger_chats` | `chat_id` | номер → пусто; запрос удаления чата у провайдера (Wazzup API), отметка в аудите |
| `messenger_messages` | `body` | тексты → «Удалено по запросу» |
| `call_intents`, `telephony_calls` (таблиц ещё нет, INTEGRATIONS §2.7) | `client_digits` | пусто |
| `call_recordings` (таблицы ещё нет) и файлы в томе `crm_recordings` | файл | файл удаляется с диска; у провайдера — запрос удаления |
| `audit_log` | — | ПДн в аудит не пишутся (только id и коды) |
| `users` | `name`, `phone_digits` — ПДн **сотрудников**, не клиентов | функцией клиента не обезличиваются; порядок для уволенных сотрудников — после 1.11 `[дозаполни: решение ЦРП и юриста, PLAN §9 В-9]` |
| `invites` | `phone_digits` — ПДн сотрудника | то же; строки удаляет `purge` по сроку |
| копии БД | все | обезличенные данные пропадают из копий не позже чем через 35 дней (7 дневных + 4 недельные) — это пишется в ответе субъекту |

---

## 5. Модель доступа

### 5.1. Как устроено

1. **Каталог разрешений** в коде (`packages/core/src/access/catalog.ts`), закрытый
   список `ресурс.действие`: `card.read|outcome|edit|assign|return|unblock|export`,
   `client.read|edit|edit_identity|merge|transfer|propose`,
   `deal.read|edit|purchase|move_back`, `booking.read|create|attend|manage|walk_in`,
   `note.write`, `task.read|write|assign_others`, `handoff.read|accept|assign`,
   `pool.read`, `distribution.manage`, `import.run`, `report.view|export`,
   `data.export_all`, `settings.sales|fields`. Новое разрешение не получает
   никто, пока его не добавит пресет.
2. **Роли** — в настройках (`CONFIG.md` §6.10): ключ, подпись, `readOnly`,
   список `grants {perm, scope}`, `relations`, меню. Охват: `own` (владелец или
   временный владелец), `team`, `space`, `all`.
3. **Отношения** — именованные предикаты из кода с параметрами из настроек.
   Дают **чтение объекта отношения плюс закрытый список действий над ним**;
   список зашит в код отношения, пресет может только сузить его (D-016):

   | Отношение | Чтение | Действия (только над объектом отношения) |
   |---|---|---|
   | `booked_with_me {fromDays:-1, toDays:30}` (консультант) | клиент, карточка, сделки, лента — в окне вокруг своей БК | `booking.attend` и итог встречи по своей БК; `booking.create` — запись клиента на БК к себе; `note.write`; `deal.purchase`; `deal.edit` — перевод сделки на «Переговоры» и «Проигран» |
   | `duty_today` (дежурный) | гости своего мероприятия в день мероприятия: имя, компания, последние 4 цифры номера | `booking.attend` на своём мероприятии; `booking.walk_in` — гость без записи |
   | `handoff_to_my_team` (руководитель отдела) | клиенты, переданные отделу, с момента передачи | `handoff.accept` (принять, отклонить с причиной), `handoff.assign` (назначить исполнителя из отдела), комментарии к задаче передачи |
   | `handoff_assigned_to_me` (сотрудник отдела) | клиенты, где он исполнитель передачи | задачи передачи и комментарии |

   Действие проверяется тем же предикатом отношения в SQL `UPDATE` (окно,
   своё мероприятие, своя запись): консультант не может изменить чужую БК или
   карточку вне окна — это строка прогона изоляции.
4. **Администратор** — признак `users.is_admin`. Он даёт права установки
   (сотрудники, роли, настройки, интеграции, лицензия, тема, праздники,
   обезличивание), но **не даёт** доступ к карточкам и полную выгрузку. Данные
   клиентов администратор видит, только если у него есть роль в пространстве.
   Назначить роль самому себе нельзя; назначение роли с охватом `space` или
   `data.export_all` пишется в аудит и уведомляет директора.
5. **Валидатор ролей** (`roleValidator.ts`) отклоняет пресет с опасными
   сочетаниями: `own` на чтение карточек вместе с `distribution.manage`,
   `pool.read`, `card.assign` или `client.transfer`; `readOnly` с любым пишущим
   разрешением, кроме `report.export`. Граница — по охвату, а не по имени роли.

### 5.2. Как проверяется в коде

1. Обёртки `route()`, `page()`, `action()` строят `Viewer { userId, spaceId,
   roleKey, grants, relations, readOnly, isAdmin, configRev, license }` из
   сессии. Членство, роль и статус перечитываются из БД **на каждом запросе**,
   кэша прав нет. Отключённый сотрудник теряет доступ на следующем запросе.
2. Обёртка объявляет нужное разрешение. Нет разрешения — 404 для объекта, 403
   для раздела. `readOnly` и лицензия `read_only`/`invalid`/`missing`
   отклоняют мутации кодом 423, кроме закрытого списка D-054: вход, выход,
   «выйти везде», смена своего пароля, сброс пароля администратором,
   отключение сотрудника с закрытием сессий, обезличивание, отзыв ключа приёма
   и токенов вебхуков, выключение интеграции, загрузка лицензии, полная
   выгрузка. Обёртка помечает такие действия `securityMutation: true`;
   список — константа ядра, пресет его не меняет.
3. Мутирующие запросы проверяют `Origin` (защита от CSRF поверх
   `SameSite=Lax`). Сессия проверяется в обёртках, а не только в
   proxy/middleware (в Next 16 читать `node_modules/next/dist/docs/`).
4. **Одна функция охвата** `scopeSql(viewer, 'card', perm)` возвращает
   SQL-фрагмент для таблицы `cards`:
   - `own`: `c.space_id = $space AND (c.owner_user_id = $me OR c.acting_user_id = $me)`;
   - `team`: владелец в моей команде;
   - `space`: `c.space_id = $space`;
   - `all`: `c.space_id = ANY($mySpaces)`;
   - для чтения добавляются `OR EXISTS (…)` отношений.
   Клиент, контакты, телефоны, сделки, записи, лента, заметки видны **через
   карточку**: отдельного предиката у них нет. Задачи: `assignee = $me AND
   карточка видна` для `own`, охват роли — для остальных. Уведомления: только
   `user_id = $me`.
5. Списки, счётчики, поиск, канбан, отчёты и выгрузка используют тот же
   фрагмент: чужие строки не выходят из БД.
6. Мутация проверяет охват в самом запросе:
   `UPDATE cards SET … WHERE id = $1 AND <scope> AND version = $v`. Обновлено
   0 строк → повторное чтение с тем же охватом: не видна — 404, видна — 409
   «карточка изменилась».
7. **Чужое = несуществующее**: 404 с тем же телом, что у несуществующего id.
   Тексты ошибок не выдают чужие записи («Запись не создана, РОП проверит»).
8. Поля: `projectFor(viewer, object, row)` убирает поля `hidden` из ответа,
   фильтров, сортировки, поиска и выгрузки. Фильтр по скрытому полю — 400.
   Запись поля проверяет `buildFieldValidator(rev, object, viewer, transition)`
   на всех путях: карточка, шторка итога, канбан, импорт, приём, слияние. Поля
   типа `url` (и `website`) принимают только `http:`/`https:`, `email` —
   только адрес; при выводе схема проверяется повторно, ссылка получает
   `rel="noopener noreferrer"` (D-051).
9. Аудит (`audit_log`, только добавление): вход, выход везде, приглашение,
   отключение, смена роли, каждая ревизия настроек (ключи без значений ПДн),
   выгрузки (кто, что, сколько строк), слияние, передача, ручная раздача,
   возврат в обзвон, снятие «Не звонить», открытие чата Wazzup, обезличивание,
   загрузка лицензии, переход в «только чтение». В `meta` — только id, коды и
   числа: у выгрузки — вид, **коды** полей фильтра и сортировки и число строк,
   но не значения (текст поиска, номер, имя, БИН). Журнал только дополняется и
   обезличиванием клиента не чистится, поэтому значение ПДн в нём осталось бы
   навсегда; тест модуля выгрузок проверяет, что `meta` не содержит значений
   фильтра.

### 5.3. Как проверяется тестами

| Тест | Что ловит | Когда роняет CI |
|---|---|---|
| `tests/unit/layers.test.ts` | импорт `SystemActor`, `sql`, `@crm/core` не из тех слоёв | всегда |
| `tests/unit/wrappers.test.ts` | route handler, server action **или страница** (`page.tsx` с динамическими параметрами, `layout.tsx`, читающий данные) без обёртки `route()`/`action()`/`page()` | всегда |
| `tests/isolation/manifest/*.ts` + статический обход `src/app/api/**/route.ts`, server actions и `src/app/**/page.tsx`, `layout.tsx` | маршрут или страница без записи в манифесте (путь, метод, разрешение, вид id, пример тела) | всегда |
| `tests/isolation/run.test.ts` на Postgres 16 | для **каждого** маршрута и страницы манифеста: оператор A получает 404 на объект оператора B; у страниц в HTML нет названия, номера и БИН объекта B; снимок затронутых таблиц не меняется | всегда |
| то же | списки и счётчики A не содержат id B; поиск A по 5+ цифрам номера B, названию, БИН — пусто | всегда |
| то же | после передачи клиента от A к B: у A сразу 404, очередь, лента, записи, задачи, уведомления A пусты | всегда |
| то же | директор ничего не меняет (423); консультант видит клиента только в окне и меняет только свою БК в окне; маркетинг — только переданных; дежурный — только гостей своего мероприятия; администратор без роли не получает карточки ни через API, ни через страницы | всегда |
| то же, на пресете `base` | изоляция не зависит от имён ролей | всегда |
| `tests/unit/roleValidator.test.ts` | опасные сочетания прав в пресете | всегда |
| `tests/unit/fields-projection.test.ts` | скрытое поле в ответе, фильтре, выгрузке | всегда |
| `tests/integration/license.test.ts` | мутации в `read_only`, `invalid`, `missing` → 423; каждое действие списка D-054 проходит; выгрузка работает; правило часов (шаг ≤ 48 ч) | всегда |
| `tests/integration/clients/depersonalize.test.ts` | после обезличивания исходных значений нет ни в одной колонке реестра §4.6 | всегда |

Синтетика прогона: пресет ЦРП, операторы A и B, РОП, консультант, дежурный,
глава маркетинга, директор, администратор без роли, 200 карточек с номерами
+7 709 …

**Гейты** (критерии — `docs/PLAN.md` §1): 22.10 вечером — зелёный прогон на
маршрутах и страницах, которые существуют к этому времени (проверка самой
обвязки); 26.10 после тега `v0.9.0` (12:00), в составе Q1d, — на полном наборе. Без зелёного 26.10 импорт на бой
не применяется. Каждый PR, который трогает `src/server/access/**`,
`scopeSql` или роли пресета, проходит `reviewer` (T2).

**Отвергли:** Postgres RLS к 1.11 (каждый запрос в транзакции с `SET LOCAL`,
обход для задач, перепроверка PGlite — не успевает; вернёмся вторым рубежом
поверх того же предиката); проверки только в маршрутах (класс BUG-044 SalemAI).

---

## 6. Фоновые задачи

### 6.1. Устройство

- Контейнер `worker` — тот же образ, команда `node --disable-sigusr1 dist/worker.mjs` (D-312). Веб-процесс
  таймеров не держит.
- Цикл раз в 30 секунд. Для каждой задачи реестра чистая функция
  `slotFor(job, now, config, calendar)` возвращает ключ слота
  (`2026-10-28T11`) или `null`. Расписание считается от пояса и рабочего
  календаря из настроек: у расписания один источник правды.
- Защита от двойного запуска: `pg_try_advisory_lock(hash(job))` на время
  прогона + `INSERT INTO job_runs (job, slot_key) … ON CONFLICT DO NOTHING`.
  Упавший прогон повторяется в том же слоте не больше 3 раз.
- Второй цикл каждые 5 секунд: `webhook_inbox`, `push_outbox` с
  `FOR UPDATE SKIP LOCKED`, повторы с экспоненциальной задержкой.
- Журнал прогонов виден администратору на странице «Состояние».
- Ручной запуск: `crmctl job run <имя> [--slot]`.
- В лицензии `read_only` воркер не раздаёт и не рассылает, но чистка, сверка и
  проверка лицензии работают.

### 6.2. Список задач

| Задача | Расписание (пресет ЦРП) | Что делает |
|---|---|---|
| `distribute` | рабочие дни, каждый час 08:00–18:00 | сначала возвраты (PROCESS 12.23; задача возвратов — неделя 2, PLAN §6.3), затем пул поровну в пределах лимита; пары не делятся; отсутствующим и на паузе не выдаёт; одно сводное уведомление на тик |
| `absence` | ежедневно 07:30 и сразу при изменении отсутствия | новые без звонков → в пул; перезвоны и повторы со сроком в эти даты и карточки с будущей записью в эти даты → временному владельцу (при «поровну» — конкретный коллега на каждую карточку); по окончании временный снимается |
| `events-ensure` | ежедневно 00:30 | мероприятия серий на `booking.horizonDays` вперёд; нерабочие дни из `calendar.holidays` пропускаются, список пропусков виден РОП на экране серии; нетронутые будущие — перегенерация; GET ничего не пишет |
| `attendance-sweep` | рабочие дни 10:00 | записи прошедших мероприятий без отметки явки → задача дежурному (БР) или консультанту (БК) и РОП «Отметьте явку»; через `booking.attendance.autoNoShowWorkdays` рабочих дней — «Не пришёл» по PROCESS 3.5 № 16; карточки `agreed` без будущей записи и без открытой задачи владельцу → задача «Записать на следующий шаг» (D-049) |
| `grey-assign` | рабочие дни 09:00, затем каждые 30 мин до 18:00 | назначает консультантов «серым» БК или предлагает РОП (режим из настроек) |
| `digest` | рабочие дни 09:00 | «У вас N перезвонов, M новых» (dedupe) |
| `callback-soon` | каждые 5 минут в рабочее время | push «перезвон через 10 минут» (выключен в пресете ЦРП до второй недели) |
| `alarms` | рабочие дни, каждый час | просроченные перезвоны (по `cards.next_call_at`, D-050), непринятые передачи, «серые» без консультанта, сделки «залежались» (`staleDays`), сверх лимита проверок номера (D-040); по настройке — запас < порога и нет запросов ключа приёма дольше порога (по `ingest_keys.last_used_at`; у ЦРП обе выключены, D-056, D-057) |
| `counters-reconcile` | ежедневно 02:30 | сверяет счётчики карточек с `calls` и чинит, пишет число расхождений |
| `config-integrity` | ежедневно 02:45 | ищет в данных ключи, которых нет в текущей ревизии настроек; число — в сводку администратора |
| `license` | при старте и каждый час | пересчёт состояния лицензии |
| `purge` | ежедневно 03:30 | просроченные сессии и приглашения; `import_rows` и `payload` вебхуков старше 14 дней; `ingest_batches` и `change_snapshots` старше 30 дней |
| `invariants` | ежедневно 02:40 | нет карточки рабочего состояния без владельца, кроме `new` (D-066); нет `agreed` без шага (D-049); число нарушений — в сводку РОП и администратора |
| `telephony-reconcile` | ежедневно 02:00, только при включённом провайдере | `listCalls` за 48 ч через тот же upsert (после 1.11) |

Бэкап и внешний мониторинг — в cron хоста: они должны работать, когда
контейнеры лежат.

**Отвергли:** cron хоста → HTTP с секретом (как в SalemAI: два источника
расписания, открытая поверхность); таймеры в веб-процессе (умирают при
выкладке).

---

## 7. PWA и офлайн

- **Манифест** `src/app/manifest.ts` строится из настроек темы (название,
  цвета, иконки). Service worker пишем руками (`public/sw.js`). Кэшируется
  только оболочка и статика. **Ответы API не кэшируются**: ПДн на телефоне не
  копятся.
- **Push** (web-push, ключи VAPID в окружении): Android и установленная PWA на
  iOS 16.4+. Колокол в приложении работает всегда и считается основным каналом.
  Push идёт через серверы Apple и Google за рубежом, поэтому в тексте push нет
  имён клиентов, номеров и названий компаний: только вид события и числа
  («У вас 12 перезвонов», «Вам передан клиент»). Подробности — в колоколе после
  входа.
- **Звонок.** «Позвонить» создаёт `opId = crypto.randomUUID()`, пишет в
  IndexedDB `pendingCall {opId, cardId, tappedAt, title, phoneMasked}` и
  открывает `tel:`. На `visibilitychange`/`pageshow` и при следующем старте
  шторка итога открывается сама из `pendingCall`.
- **Итог (кроме «Договорились»).** Одно нажатие кладёт в IndexedDB `outbox`
  запись `{opId, cardId, outcomeCode, …, occurredAt, notBefore = now + 5 с}` и
  сразу показывает следующую карточку. «Отменить» в течение 5 секунд удаляет
  запись из outbox — сервер её не видит. «Следующая» отправляет сразу.
  Отправка — после `notBefore`, на `online`, `focus` и раз в 15 секунд
  (Background Sync на iOS нет). Внизу баннер «Не отправлено: N».
- **«Договорились — записать»** работает только онлайн: проверка мест и
  слотов на сервере. Мастер отправляет одну транзакцию «итог + запись +
  сделка» с `opId` как `request_id`. Окна отмены нет; ошибку исправляют
  обычной отменой записи с причиной «ошибка оператора» (PROCESS 12.7).
- **Сервер.** `POST /api/calls/outcomes` с `opId`:
  `INSERT INTO calls (id = opId, …) ON CONFLICT (id) DO NOTHING RETURNING`.
  Строка уже есть — возвращается прежний результат. Применение к карточке:
  - карточка больше не видна оператору (передали) → `applied='fact_only'`,
    `fact_reason='owner_changed'`, задача новому владельцу «Проверьте итог
    прежнего владельца», ответ 200 `fact_only` (PROCESS 12.5);
  - у карточки уже есть итог с более поздним `occurred_at` → `fact_only`,
    `stale`;
  - иначе — применить по машине состояний, `version+1`;
  - `occurredAt` ограничен окном `[получено − 72 ч, получено + 5 мин]`.
- **Пропуск** — запрос с `opId` (PK `skips.id`); лимит дня считает сервер.
- **Очередь** держится в памяти страницы (текущая и следующие 3 карточки), в
  IndexedDB не пишется. Без сети и без памяти страницы — экран «Нет сети,
  итоги сохранены».
- **Выход** сначала отправляет outbox, затем очищает IndexedDB. Не удалось —
  предупреждение «Есть неотправленные итоги».
- **Счётчик неотправленных на сервере** (D-063). Каждый запрос PWA и пинг
  `POST /api/device/ping` раз в 5 минут (пока приложение открыто) несут
  `X-Outbox-Pending` и `X-Outbox-Last-Flush`; `device_id` — случайный id в
  IndexedDB. Сервер пишет `device_status` (без ПДн), сводка РОП показывает
  «Не отправлено с устройств: N» и «последняя связь» по операторам.
- **Лицензия `read_only`.** Сервер отвечает 423, итоги остаются в outbox.
- Тесты Playwright: `context.setOffline(true)`, двойная отправка, выгрузка
  вкладки посреди шторки, передача карточки во время офлайна, отмена за 5 с.

---

## 8. Поставка, защита кода, лицензия

### 8.1. Что стоит на сервере

- Хост: Ubuntu 24.04, Docker Engine, nginx и certbot на хосте (шаблоны crp-kz:
  CSP, HSTS, журнал без query string), ufw (наружу 22, 80 и 443; SSH только
  по ключу, по возможности с ограничением по IP), fail2ban.
- Compose-проект `crm`: `db` (postgres:16, том `crm_pg`, роли `crm_owner` и
  `crm_app`), `app` (Next standalone, `127.0.0.1:3100`, один процесс — лимиты
  входа в памяти), `worker`, разовый `migrate`. Сети: `crm_internal` (app,
  worker, db) и `crm_ingest` — **внешняя** сеть, её создаёт `install.sh`, а не
  compose CRM (пересоздание проекта не отключает чужой). В `crm_ingest` у
  активного `app` псевдоним `crm-app`; при обновлении псевдоним переходит на
  новый контейнер вместе с переключением nginx.
- Источник лидов ЦРП — отдельный compose-проект владельца со своей БД.
  Подключается к `crm_ingest` и видит только `http://crm-app:3000`. Слушающих
  портов в `crm_ingest` у него нет, поэтому CRM к нему подключиться не может,
  даже по ошибке. К `crm_internal` и БД CRM доступа нет. Предел защиты от
  root — DEPLOY §8.3.
- `/api/ingest/` закрыт снаружи двумя рубежами: nginx (пока `INGEST_PUBLIC=0`)
  и само приложение (D-155). Порт приложения открыт и из `crm_ingest`, где
  заголовки может прислать кто угодно, поэтому метки nginx (`X-Via-Proxy`,
  `X-Real-IP`, `X-Forwarded-For`) принимаются только вместе с `X-Proxy-Secret`
  = `CRM_PROXY_SECRET` (секрет пишет `crmctl install/update` в конфиг nginx и
  `app.env`; клиентский заголовок nginx затирает своим). Верный секрет и
  `INGEST_PUBLIC=0` → 404; метка без верного секрета → 404 всегда; без меток —
  внутренний источник (тест в `tests/integration/intake/`).
- Стенд — отдельный сервер с синтетикой (D-030, D-044).

### 8.2. Сборка и пакет

1. CI (приватный репозиторий): `tsc`, lint, unit, integration на Postgres 16,
   изоляция, e2e на собранном образе.
2. `packages/core` → esbuild (один файл) → `javascript-obfuscator`
   (переименование, перестановка потока, без тяжёлого шифрования строк) →
   `dist/index.mjs`. Next подключает его как внешний серверный пакет
   (`serverExternalPackages`). Клиентские компоненты `@crm/core` не
   импортируют (линтер).
3. `next build --webpack`, `output: 'standalone'`,
   `productionBrowserSourceMaps: false`; воркер и CLI — esbuild, минификация.
4. Образ: `.next/standalone`, `.next/static`, `dist/worker.mjs`,
   `dist/crmctl.mjs`, `migrations/*.sql`, `presets/base`, `presets/consulting-sales`.
   Нет `src/`, `*.ts`, `tests/`, `.git`. Шаг CI ищет `*.map` и `src/` в образе
   и роняет сборку.
5. Слой клиента: `FROM crm-app:<версия>` + ядро, собранное с `CUSTOMER_ID` и
   `BUILD_ID` (водяной знак в нескольких местах ядра) + метка образа. Если K0
   не сойдётся и ядро останется в бандле Next, водяной знак — константа в
   `src/server/platform/watermark.generated.ts`, и `next build` идёт отдельно
   на каждого клиента по тегу (D-028).
6. Пакет `crm-<customer>-<ver>.tar.zst`: `docker save`, `compose.yml`,
   `manifest.json` (digest образов, версия схемы БД, версия схемы настроек,
   минимальная версия для обновления), `manifest.sig`. CI подписывает пакет
   только ключом `stage` (ему доверяет лишь стенд); клиентский пакет владелец
   подписывает у себя ключом релизов (D-064).
7. **Что проверяем.** Полный e2e и прогон изоляции идут на том самом
   подписанном клиентском пакете, поставленном на стенд через `crmctl update`
   (обфусцированное ядро — с 28.10, PLAN §4), а не только на общем образе.

### 8.3. Обновление и откат

`crmctl update <пакет>` на сервере: проверить подпись → загрузить образы →
проверить лицензию **новым** образом (при `invalid` — стоп до переключения) →
бэкап, если есть новые миграции → `migrate` (SQL, под `crm_owner`) и миграции
настроек (новая ревизия, старая остаётся) → поднять новый `app`, проверить
`/api/health` → переключить nginx и псевдоним `crm-app`, через 2 минуты
проверить снова → при сбое откат на прежний тег. БД не откатывается:
миграции только добавляющие; прежняя версия читает новую схему и берёт
последнюю ревизию настроек со своей `schema_version` (D-060). `crmctl
rollback` — около минуты.

Бэкап: cron хоста ночью, а в пилот до 15.11 ещё каждый час 09:00–19:00
(D-031), `pg_dump -Fc` из контейнера `db`, шифрование age на открытые ключи
двух хранителей, 7 дневных и 4 недельные копии, раз в неделю восстановление во
временный контейнер со сверкой. Проверки восстановления: 22.10 (CI или
локальный Docker, синтетика), 26.10, 30.10, цель — не дольше 30 минут.
Вторая копия вне ВМ, в РК (D-044).

Мониторинг: `healthcheck.sh` (crp-kz) раз в 5 минут, тревоги в Telegram-бот
на ТОО ЦРП. Только статусы, без ПДн.

### 8.4. Лицензия

Уточнено D-211…D-214, D-290, D-306, D-307 и D-312 (все — «предложено»); ниже — как сделано в коде.

- Формат `CRM1.<base64url(payload)>.<base64url(sig)>`, Ed25519; подпись покрывает
  `CRM1.<payload>`. Payload: `v`=1, `lid`, `kid`, `customer`, `installId`,
  `issuedAt`, `notBefore`, `expiresAt` (epoch-мс), `graceDays` (0–365),
  `features[]`, `seats?`, `buildId?` (если задан — лицензия только для этой
  сборки). `customer` вместо прежнего `customerId`; `edition` и `supportUntil`
  не вводим (D-211).
- Открытые ключи (по `kid`) вшиты в обфусцированное ядро (`build.mjs
  --license-keys`), там же водяной знак: клиент, `buildId` и время сборки
  `builtAt` (`--built-at`, `Dockerfile` `BUILT_AT`, D-290). Закрытый ключ — только у владельца офлайн. Утилита подписи
  `scripts/license-sign.ts` ключа не содержит. Сборка клиента не принимает ключи
  `test-*`. Общая сборка без водяного знака (dev, тесты, e2e, общий образ CI)
  без лицензии работает, загруженную проверяет так же строго (D-213); клиенту
  её не ставят: `crmctl install`, `crmctl license install` и проверка нового
  образа в `crmctl update` сверяют водяной знак ядра образа с клиентом.
- Порядок выдачи: `crmctl install` создаёт `installId` → владелец подписывает
  лицензию под него офлайн → `crmctl license install`. Заранее, до установки,
  лицензию подписать нельзя.
- `installId` создаётся при установке, хранится в `license_state` и томе. К
  железу не привязан: восстановление на новой ВМ работает.
- Текст — из файла `LICENSE_PATH`; без файла или если файл не годится (подпись,
  мусор, чужие `installId`/клиент/ключ, срок не начался) или не читается (не
  обычный файл — каталог, канал, устройство; нет прав; ошибка ввода-вывода) — из
  проверенной копии `license_state.license_raw`, как без файла: порча файла не
  даёт 500 ни выгрузке, ни мутациям безопасности (D-054, D-290). Копию затирает только действующая
  лицензия. Пересчёт без сети: при запросе не чаще раза в минуту на процесс и
  задачей воркера `license` (при старте и раз в час). Готовому состоянию из БД не
  доверяем: оно всегда считается заново из подписанного текста. Правка `state`,
  `invalid_since` или `last_seen_at` в обход crmctl «только чтение» не снимает и
  льготу не продлевает: `invalid_since` только показывается (D-211, D-290).
- Льгота `invalid` — только у лицензии прежней сборки (`wrong_build`): до
  `min(builtAt + 7 сут, expiresAt + graceDays копии)`, если в БД лежит копия,
  проходящая подпись, `installId` и клиента. Без `builtAt` или копии — сразу как
  `read_only`. Поэтому лицензию под новую сборку выпускают в течение 7 суток от
  сборки (или без `buildId`); `crmctl update` в это окно пропускает лицензию
  прежней сборки с предупреждением, после — отказывает (D-290).
- Правило часов. `last_seen_at` — максимум виденного «сейчас», назад время
  лицензии не идёт. Часы впереди больше чем на 48 ч — оценка по часам, а
  `last_seen_at` сдвигается на 48 ч и не чаще раза в час, тревога
  `license.clock_jump` (`forward`); после починки часов лицензия снова
  считается по ним (D-212).
- Часы позади `last_seen_at` больше чем на 10 минут (D-306) — время лицензии
  **не стоит**: оно идёт по прошедшему времени, видимому без часов, —
  монотонному времени процесса (`performance.now()` прошлого пересчёта, в
  памяти процесса) и ходу самих часов от прошлого пересчёта (показание в
  `license_state.clock_behind_last`, поэтому перезапуск процесса время не
  замораживает). Пересчёт без опоры процесса (первый после старта) двигает
  время не меньше чем на минуту — срок кэша состояния процесса: его снимок
  обслуживает запросы не дольше минуты. Поэтому перезапуск перед каждым
  пересчётом при часах в одной точке время не останавливает: оно растёт не
  медленнее времени работы приложения, через 48 ч — «только чтение».
  Тревога `license.clock_jump` (`backward`) — в начале эпизода и раз в сутки.
  Эпизод дольше 48 ч по времени лицензии — `read_only` с причиной `clock`
  (мутации безопасности D-054, просмотр и выгрузка работают), пока часы не
  починят (`chrony`). Шаги вперёд в эту оценку не входят
  (`clock_real_at`): после починки ушедших вперёд часов время стоит, пока часы
  не догонят, и блокировки нет. Дрейф до 10 минут — время ждёт часы, как
  раньше, но не дольше 10 минут по монотонному времени процесса.
- Подписанный `clockResetTo` (D-029) не реализован: если ложное «сейчас» уже
  записано, владелец сбрасывает `license_state.last_seen_at` (и `clock_*`)
  через psql в контейнере `db` (RUNBOOK «Лицензия»).
- Образ, ядро которого не сообщает время сборки (собран до D-290), клиенту не
  ставится: `crmctl install`, `update` и `rollback` отказывают до переключения
  (D-307).
- Запуск сборки клиента (D-312): app и worker стартуют только как в поставке —
  `node --disable-sigusr1` (инспектор сигналом SIGUSR1 не открывается), в
  аргументах node и `NODE_OPTIONS` только `--disable-sigusr1` и
  `--max-old-space-size=N`, `LD_PRELOAD` пуст, инспектор закрыт. Иначе процесс
  выходит с кодом 1, в журнале контейнера `license.runtime_tamper` (имена
  флагов, без путей). Это не состояние лицензии: как отказ запуска без
  `APP_ORIGIN` (D-155), снимается возвратом команды поставки. Общая сборка не
  проверяется (стенд, CI, e2e с предзагрузкой ядра рабочей копии).

| Состояние | Когда | Что происходит |
|---|---|---|
| `valid` | — | всё работает |
| `expiring` | за 14 дней | баннер администраторам |
| `expired` | срок прошёл, идёт льготный период | баннер всем, работа полностью |
| `read_only` | льготный период кончился; или часы сервера позади дольше 48 ч (причина `clock`, D-306) | мутации — 423, кроме мутаций безопасности D-054; работают просмотр и **полная выгрузка**; воркер не раздаёт и не рассылает; приём лидов отвечает «не принимаем» |
| `invalid` | разбор или подпись не сходятся, незнакомый `kid`, чужой `installId`, `customer` ≠ водяной знак, чужой `buildId`, `notBefore` впереди | `wrong_build` при подписанной копии рабочей лицензии этой установки в БД — баннер всем и льгота до `builtAt + 7 сут`, но не дальше `expiresAt + graceDays` копии (D-290), затем как `read_only`; остальные причины, сборка без `builtAt` или без такой копии — сразу как `read_only` (негодный файл при рабочей копии сюда не попадает — вердикт по копии); сообщение администратору и в Telegram |
| `missing` | лицензия не загружена | как `read_only` (на стенде — лицензия с пометкой stage) |

Данные не удаляются, не шифруются и не блокируются для выгрузки ни в каком
состоянии. `seats` — мягкий предел: баннер и запрет новых приглашений сверх
лимита. `features` открывают модули (`messenger.wazzup`, `telephony.zadarma`,
`spaces.multi`) без отдельной сборки.

Честно: полной защиты от root нет, сетевой трафик виден. Один перевод часов
назад (без правки БД) срок не продлевает и через 48 ч даёт `read_only`
(D-306). Остаток, который офлайн-лицензия не закрывает без доверенного
источника времени (онлайн-проверка, аппаратный счётчик) — ждёт владельца
(PLAN §9 В-7, D-212, D-306): root переводит часы назад **и** правит
`license_state` (`last_seen_at`, `clock_*`) через psql или триггером в БД —
держит лицензию сколько угодно. Возврат часов в одну точку с перезапуском
процессов перед каждым пересчётом срок не держит: каждый пересчёт без опоры
двигает время на минуту (D-306).
Рантайм-инъекция — тот же остаток, что правка выполняемого кода (D-312):
проверка запуска сидит в том же процессе, и предзагрузка, написанная под неё
(правит `process.execArgv`, `NODE_OPTIONS`, `inspector`), свой `server.js` или
ядро томом поверх образа, `/etc/ld.so.preload` томом, ptrace или отладчик с
хоста, свой образ — подменяют `node:crypto` или состояние в памяти и держат
лицензию без ключа сколько угодно. Обфускация и проверка запуска — планка
(обход надо написать, и это доказательство умысла по договору), а не барьер.
Закрывает только онлайн-проверка или доверенное железо.
Цель — сделать копирование дороже лицензии и доказуемым через водяной знак и
договор.

---

## 9. Перенос кода

### 9.1. Из SalemAI: белый список (ветка `integration/crp-wave1`, SHA `108fb70`)

Копируем функцию или файл вместе с его юнит-тестом. В шапке файла:
`Источник: SalemAI 108fb70 <путь>`. При переносе: константы ЦРП уходят в
настройки, реальные имена и номера из тестов заменяются синтетикой, пояс
берётся из настроек. SQL-репозитории SalemAI — только образец, SQL пишем
заново. Работу по переносу делает T1 по чек-листу; поиск констант — T0.

| Что | Файлы и функции SalemAI | Куда | Что меняем |
|---|---|---|---|
| Итоги и повторы | `src/lib/crm/coldCall.ts`: `nextRedialAt`, `isReasonCodeFor`, `reasonText`, `formatKzPhone`; тест `tests/unit/crm-cold-call.test.ts` | `core/calling/` | `applyOutcome` и `closedKindFor` **переписываются** под 9 состояний и 7 видов PROCESS 3.5; повторы — по рабочему календарю и шагам из настроек; тест-векторы SalemAI сохраняем там, где поведение совпало |
| План раздачи | `src/lib/crm/coldAutoPlan.ts`: `planEvenDistribution`; тест `crm-cold-autoplan.test.ts` | `core/distribution/` | порядок «меньше открытых, затем меньше выдано»; пары не делятся; мобильные раньше; лимит по видам выдачи |
| Импорт таблиц | `src/lib/crm/coldImport.ts`: `parseCsvRecords`, `normalizeCompanyName`, `normalizePersonName`, `parseAnswerCell`, `parseLpr`, `parseTargetStatus`, `parseOperatorRules`, `resolveRowOwner`, `ruleOverlaps`; тест `crm-cold-import.test.ts` | `core/import/`, `core/names/` | `importedState`, `sheetRowState`, `angelRowsFromGrid` переписываются под профиль импорта; приоритет итогов в ячейке — PROCESS 3.7 |
| Дедуп | `src/lib/db/crm/coldMatch.ts`: логика `findColdMatch`, `addColdDupCandidates`; `src/lib/db/crm/dedup.ts`: `normalizeEmail` | `core/dedup/` (чистая часть), SQL заново | БИН → номер + название → пара; стоп-лист по HMAC; ИИН только HMAC |
| Номера РК | `src/lib/db/crm/phone.ts`: `normalizePhone` + `phone.test.ts`; `src/lib/crm/clients/link.ts`: `canonicalColdDigits`; `coldImport.ts`: `phoneKind`, `isPlaceholderPhone`, `splitPhones` | `core/phone/` | три реализации → одна с общими тест-векторами; префиксы из `phone.*` настроек |
| Ядро записи и слоты | `src/lib/crm/booking/`: `types.ts`, `time.ts`, `statusMachine.ts` (`allowedTargets`, `checkTransition`), `slots.ts` (`effectiveDay`, `workWindows`, `slotStarts`, `countOverlapping`, `buildSlots`, `fitsPlan`, `intervalsToDay`), `greyTiming.ts`, `reminders.ts` (`reminderBucket`, `reminderDates`), `errors.ts`, `csv.ts`, `summary.ts` (только чистые функции), `autoAssign.ts` (только `greyBookings`, `poolCandidates`, `planGreyProposals`, `pendingGreys`, `nextBoundary`); тесты `crm-booking-core`, `-slots`, `-summary` | `core/booking/` | `time.ts` получает пояс параметром; статусы `moved_br/moved_bk` → `moved`; константы `GREY_*` → `booking.grey.schedule` |
| Подбор консультанта | `src/lib/crm/booking/suggest.ts`: `rankConsultants`, `rankAssignCandidates`; тест `crm-booking-suggest.test.ts` | `core/booking/` | направления — ключи из настроек |
| Слияние контактов | `src/lib/db/crm/contacts.ts`: логика метода `merge(survivorId, loserIds, …)` (какие ссылки переносятся) | `domain/clients/merge.ts`, SQL заново | правила PROCESS 12.20; предпросмотр; тест «все таблицы со ссылкой на клиента перенесены» |
| Передача клиента | `src/lib/crm/clients/owner.ts`: логика `reassignOwner`; `src/lib/crm/purchases/routing.ts`: `routeFor`, `isRepeat`, `buildClientBrief` | `domain/team/transfer.ts`, `core/handoff/` | переносятся будущие записи, открытые задачи и сделки, напоминания; сводка для отдела без ПДн сверх нужного (PLAN §9 В-29) |

Не переносим: доступ (`coldCallAccess.ts`, `clients/access.ts`, `booking/access.ts`),
UI, лента (`timeline.ts` собирает из источников — у нас таблица), сборщик
(`coldCollection.ts`), кроны, биллинг, ИИ-модули, всё остальное.

### 9.2. Из crp-kz (SHA `2cd8a2b`, копия с переименованием `crp` → `crm`)

| Что | Пути | Что меняем |
|---|---|---|
| БД | `src/lib/db/{core,index,locks,migrate,postgres,testing}.ts` | `getDb()` из контекста; без сида LMS |
| Вход и сессии | `src/lib/auth/{session,password,rateLimit,clientIp,token,tokens,safeNext}.ts` | роли LMS убираем; вход по телефону; приглашения и «выйти везде» |
| Аудит | `src/lib/audit.ts` | свой список действий |
| Очередь | `src/lib/mail/outbox.ts`, `worker.ts` (принцип SKIP LOCKED, аренда, повторы) | для `push_outbox` и `webhook_inbox` |
| Файлы | `src/lib/storage/{sniff,zip,ooxml,limits}.ts` | проверка CSV/XLSX по сигнатуре и лимитам zip при импорте |
| Флаги, окружение | `src/lib/features.ts`, `src/lib/env.ts` | убрать импорты legal и mail; production без БД падает |
| Админка | `src/lib/admin/{guard,result}.ts` | как образец обёртки |
| CSV | `src/lib/team/csv.ts` | защита от формул во всех выгрузках |
| UI и бренд | `src/components/ui/*` (27 компонентов), `src/styles/tokens.css`, `docs/brand/logo/` | токены в тему из настроек; логотипы не перерисовываем |
| Выкладка | `deploy/nginx/*`, `deploy/postgres/{roles,grants}.sql`, `deploy/bin/{backup,restore,healthcheck,lib}.sh` | под Docker; PM2 и `deploy.sh` не берём |
| Тесты и CI | node:test + tsx, PGlite или `TEST_DATABASE_URL`, тест паритета локалей, тест идемпотентности миграций, `.github/workflows/ci.yml` | PGlite не берём: тесты только на Postgres 16 (`TEST_DATABASE_URL`); + изоляция, образ, пакет |
| Правила агентов | `docs/agents/ROUTING.md` | копия |

### 9.3. Пишем заново

Доступ (`Viewer`, `scopeSql`, обёртки, манифест), настройки (`ConfigV1`, слои,
ревизии, миграции настроек), движок полей, лента и счётчики, все SQL-репозитории,
приём `ingest/v1`, импорт-оркестратор с предпросмотром, раздача-оркестратор,
сделки и канбан, передачи в отдел, задачи, отчёты, уведомления, контракт
плагинов и все плагины, секреты, лицензия и водяной знак, PWA и офлайн-очередь,
весь интерфейс (две оболочки: оператор — нижнее меню на телефоне, менеджер —
боковое на ноутбуке), Dockerfile, compose, `crmctl`, пакет поставки.

---

## 10. Проверки перед пушем и приёмкой

- Перед пушем: `npx tsc --noEmit`, `npm run lint`, `npm run test:unit`,
  интеграционные тесты затронутого модуля, прогон изоляции, если тронут доступ
  или маршруты. Тест нельзя отключать ради зелёного прогона.
- e2e по ролям: вход → очередь → итог → офлайн → запись на БР → явка → БК →
  покупка → передача в отдел → отчёт.
- Таблица переходов PROCESS 3.5 — юнит-тесты по строке на переход.
- Граничные случаи PROCESS 12.1–12.40 — интеграционные тесты.
- Время и календарь: тесты на 26.10.2026 (перенос), пятницу 17:00, праздники,
  проверку `Asia/Almaty = UTC+5` при старте.
- Нагрузка: 5 000 карточек, 10 операторов, 400 выдач за тик — тик раздачи
  не дольше 5 секунд, очередь оператора — не дольше 300 мс.
- Восстановление из бэкапа на чистой ВМ — не дольше 30 минут.

---

## 11. Оценки объёма

**График по дням, уровни задач, очередь `architect` и критерии гейтов —
только в `docs/PLAN.md` §1–§4.** Здесь — оценки, на которые план опирается.
Агенто-день — день работы одного агента. «П» — нужно к пилоту 27.10 (после
переноса списка А из PLAN §6.3).

| № | Задача | Дней | П |
|---|---|---|---|
| P1 | Каркас из crp-kz: db, migrate с контрольными суммами, audit, env, flags, обвязка тестов, CI | 0,75 | П |
| P2 | Миграции схемы v1 (§4, реестр ПДн §4.6) | 1,0 | П |
| P3 | Вход по телефону, сессии, лимиты, приглашения, «выйти везде» | 0,75 | П |
| P4 | Доступ: P4a ядро (`Viewer`, `scopeSql`, отношения с действиями, обёртки) — 1,0; P4b статические тесты (с проверкой страниц), манифест, обвязка изоляции — 0,75 | 1,75 | П |
| P5 | Настройки: `ConfigV1`, слои с `kz`, ревизии, совместимый геттер, `crmctl config apply/diff/rollback` | 1,25 | П |
| P6 | Время и рабочий календарь (чистые функции), данные слоя `kz` | 0,5 | П |
| P7 | Воркер: планировщик, `job_runs`, outbox, `webhook_inbox` | 0,75 | П |
| P8 | Уведомления: P8a колокол, сводка, тревоги — 0,5 (П); P8b push — 0,25 | 0,75 | П (P8a) |
| P9 | i18n ru, кит UI, токены, тема из настроек, две оболочки | 1,0 | П |
| P10 | Лицензия: формат, проверка, состояния, 423, мутации безопасности — 0,75 (П); P10b баннер — 0,1 | 0,85 | П (P10) |
| K0 | Проверка: `@crm/core` как внешний пакет в Next 16 + обфускатор (21.10) | 0,25 | П |
| K1 | Перенос чистой логики SalemAI по §9.1 с тестами; машина состояний по PROCESS 3.5 | 1,5 | П |
| K2 | Движок полей: `buildFieldValidator` (с `url`/`email`, `pii`), `projectFor`, `search_norm` | 0,75 | П |
| K3 | Поиск констант ЦРП в переносимых файлах, список «в настройки» | 0,25 | П |
| C2 | Клиенты, контакты, телефоны, поля по правам | 1,0 | П |
| C3 | Приём `ingest/v1`, дедуп, стоп-лист, `rejectRules`, `demand`, `crmctl ingest-key` | 1,0 | П |
| C4 | Импорт: загрузка, профиль, ключи строки и состояния, предпросмотр, применение, очистка | 1,25 | П |
| C4b | Профиль импорта «Записи» | 0,5 | к 28.10 |
| C5 | Итоги: API, офлайн-применение, пропуски, «Номер не работает», `tasks/auto.ts` | 1,0 | П |
| C6 | Раздача: пул, авто, вручную, лимит, пары, «Отсутствует», «Пауза» — 1,0 (П); возвраты 90 дней — 0,25 (неделя 2) | 1,25 | П (1,0) |
| C7 | UI оператора: «Звонить», шторка, PWA, SW, outbox и счётчик на сервере, перезвоны, поиск | 2,25 | П |
| C8 | Карточка клиента: поля, лента, заметки, итоговый отчёт, история сделок | 1,0 | П |
| C9 | Архив, «Вернуть в обзвон», «Мои клиенты», «Предложить контакт» | 0,75 | |
| B2 | Мероприятия, серии (праздники), запись на БР, перенос, отмена, «не пришёл», исправление явки | 1,25 | П |
| B3 | Мастер записи БР, минимальная заявка на БК, «Записи», напоминания `wa.me` | 1,25 | П |
| B4 | Дежурство и явка, гость без записи — 0,5; B4b `attendance-sweep` и инвариант `agreed` — 0,5 | 1,0 | к 28.10 |
| B5 | БК: ресурсы, график, мастер с подбором, «серые», экран консультанта | 1,75 | |
| B6 | Сделки, покупки (деньги, идемпотентно), передача в отдел, тревога | 1,0 | |
| B7 | Задачи и комментарии | 0,5 | |
| B8 | Канбан сделок (и вид «Обзвон» для РОП) | 0,75 | |
| B9 | Передача клиента, отключение сотрудника и «срочно», разбор пар, слияние со снимком, обезличивание по реестру | 1,5 | |
| R1 | Сводка РОП: R1a — 0,5 (П); R1b минимум — 0,25 (П); остальное — 0,25 | 1,0 | П (0,75) |
| R2 | Настройки продаж (числа), сотрудники, назначение ролей, праздники | 0,75 | П (сотрудники) |
| R3 | Отчёты, «звонков в час» против мягкой цели, воронка, выгрузки с журналом, полная выгрузка | 1,25 | |
| R4 | Панель директора (только чтение) | 0,5 | |
| O1 | Dockerfile, compose, сборка ядра, проверка «нет `.map` и `src/`»; O1b обфусцированное ядро и пакет клиента (28.10) | 1,0 | П (без O1b) |
| O2 | `crmctl install/update/rollback`, проверка лицензии до переключения, nginx, healthcheck | 1,0 | П |
| O3 | Бэкап и восстановление, RUNBOOK | 0,5 | П |
| O4 | CI: проверки, пакет `stage`, релизный конвейер (D-064), стенд | 0,75 | П |
| O5 | Секреты AES-256-GCM с `kid`, `crmctl secrets rotate` | 0,5 | |
| O6 | Контракт плагинов, реестр, `telephony.manual`, `messenger.wa_link`, заготовка Beeline | 0,75 | |
| O7 | `messenger.wazzup` и `telephony.zadarma` за флагами, на фикстурах | 2,0 | |
| O8 | Пресеты `base`, `kz`, `consulting-sales`, накладка ЦРП (роли — architect); синтетический сид | 0,75 | П |
| L1 | Ключи локалей по готовому списку, переименования в каркасе | 0,25 | П |
| Q1 | Прогон изоляции на двух пресетах, e2e по ролям, восстановление | 2,25 | П (1,0) |
| Q2 | Ревью PR | 2,0 | |
| | **Итого** | **≈ 45** | **≈ 27** |

Ёмкость до заморозки 26.10 ≈ 27 агенто-дней: запаса нет. Следующий рычаг —
запасная дата первой группы, а не резка обязательного (PLAN §0, §6.3).

---

## 12. Главные риски

Полный список с действиями — `docs/PLAN.md` §8.1. Архитектурные:

| # | Риск | Как снимаем |
|---|---|---|
| 1 | ВМ HyperCloud не готова к 23.10 (договор, ЭСФ, без карты) | письмо о тестовом периоде 20.10; образ не зависит от провайдера; запасной вариант D-045 |
| 2 | Утечка чужой карточки | предикат в SQL; манифест маршрутов и страниц; гейты 22.10 и 26.10; reviewer на каждый PR доступа |
| 3 | Не хватает ёмкости агентов | очередь architect (PLAN §3.2); перенос вместо написания; T0/T1 на механику; список резки А |
| 4 | iPhone выгружает PWA | восстановление шторки из IndexedDB; счётчик неотправленных на сервере (D-063); проверка на реальных iPhone и Android 23.10 |
| 5 | Качество таблиц операторов | предпросмотр с отчётом; карта «диапазон → оператор» утверждает РОП; ключ состояния при дозагрузке (D-048) |
| 6 | `@crm/core` как внешний пакет ломает сборку Next 16 | проверка K0 21.10; запасной вариант D-028 (вопрос В-1) |
| 7 | Ошибки времени и календаря | только чистые функции с `now` в параметре; проверка tzdata при старте |
| 8 | Потеря ключей окружения (секреты, HMAC) | копия у владельца и в запечатанном конверте у директора ЦРП (вопрос В-22) |

---

## 13. Вопросы владельцу

Перенесены в единый список `docs/PLAN.md` §9. Соответствие прежних номеров
этого раздела: 1 → В-21, 2 → В-10, 3 → В-16, 4 → В-15, 5 → В-1, 6 → В-7,
7 → В-22, 8 → В-20, 9 → В-23, 10 → В-9, 11 → В-24, 12 → В-29, 13 → В-28.
