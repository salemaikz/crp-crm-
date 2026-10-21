# Интеграции

Статус: **итоговый дизайн architect от 20.10.2026, ред. 2 после ревью**. Источники: разборы
телефонии РК и Wazzup (20.10.2026), `docs/ARCHITECTURE.md`, `docs/PROCESS.md`.
Все номера в примерах — синтетические +7 709 …

Содержание: 1. Общий контракт · 2. Телефония · 3. Мессенджеры и Wazzup ·
4. Приём вебхуков · 5. API приёма лидов · 6. Контракт для источника лидов ЦРП ·
7. Секреты · 8. Исходящие соединения.

---

## 1. Общий контракт плагина

Интеграции — **встроенные плагины**: собираются в образ, во время работы ничего
не подгружается. Реестр статический: `src/integrations/registry.ts`.

```ts
// src/integrations/contract.ts
export interface Plugin<C, S> {
  id: string;                        // 'telephony.manual' | 'telephony.beeline' | 'telephony.zadarma'
                                     // | 'messenger.wa_link' | 'messenger.wazzup'
  kind: 'telephony' | 'messenger';
  version: number;
  flag?: string;                     // FEATURE_<…>: выключен в production до приёмки
  licenseFeature?: string;           // без признака в лицензии плагин недоступен
  crossBorder: boolean;              // данные уходят за рубеж → нужно решение клиента о ПДн
  configSchema: ZodType<C>;          // несекретные настройки (integrations.config)
  secretsSchema: ZodType<S>;         // секреты (integration_secrets, AES-256-GCM)
  healthCheck(ctx: Ctx<C, S>): Promise<{ ok: boolean; code: string }>;
  webhook?: {
    verify(ctx: Ctx<C, S>, req: RawRequest): VerifyResult;     // ничего не пишет в БД
    dedupeKeys(ctx: Ctx<C, S>, req: RawRequest): DedupeItem[]; // ключи идемпотентности
    parse(ctx: Ctx<C, S>, raw: unknown): NormalizedEvent[];    // чистая функция, тесты на фикстурах
  };
}
// NormalizedEvent = CallEvent | MessageEvent | ChannelEvent — без полей провайдера
```

- Включение = флаг окружения ∧ признак лицензии ∧ переключатель
  администратора (`CONFIG.md` §8). Для `crossBorder: true` — ещё и отметка
  администратора «есть письменное решение о передаче ПДн за рубеж» с датой
  (пишется в аудит).
- Ядро и домен видят только нормализованные события. Цепочка:
  `webhook_inbox` → воркер → `applyEvent()` → `calls` / `messenger_messages` /
  новый клиент → `client_events`, задачи, уведомления.
- Каждый плагин покрыт тестами на фикстурах
  (`tests/integrations/<plugin>/fixtures/*.json`): повтор, порядок, неверная
  подлинность (подпись или токен — что даёт провайдер), чужой `channelId`,
  скрытый номер.

Таблицы (общие): `integrations(id, plugin_id, space_id, config jsonb, enabled,
status, last_event_at, crossborder_approved_at)`, `integration_secrets`,
`webhook_inbox` (DDL — `ARCHITECTURE.md` §4.3).

---

## 2. Телефония

### 2.1. Интерфейс

```ts
// src/integrations/telephony/types.ts (сокращённо из разбора телефонии РК §6.1)
export interface TelephonyPlugin extends Plugin<TelConfig, TelSecrets> {
  capabilities: {
    clickToCall: 'tel' | 'callback' | 'originate';
    clientFirst: boolean;            // «сначала клиент»: не платим плечо оператора на недозвоне
    webhooks: boolean;
    recordings: 'none' | 'link' | 'stream';
    listCalls: boolean;
    returnsCallIdOnInitiate: boolean;
  };
  initiateCall(ctx, input: {
    userId: string; operatorRef?: string; clientDigits: string;
    mode: 'operator-first' | 'client-first'; correlationId: string;   // = opId
  }): Promise<
    | { kind: 'tel'; href: string }                                    // manual
    | { kind: 'started'; externalCallId?: string }
    | { kind: 'error'; code: 'bad_number' | 'no_endpoint' | 'auth' | 'limit' | 'provider_down' | 'rejected' }
  >;
  fetchRecording?(ctx, ref: string): Promise<RecordingResult>;
  listCalls?(ctx, q: { from: number; to: number; cursor?: string }): Promise<{ events: CallEvent[]; next?: string }>;
}

export interface CallEvent {
  type: 'call.initiated' | 'call.answered' | 'call.ended' | 'recording.ready';
  externalCallId: string; occurredAt: number;
  direction: 'outbound' | 'inbound';
  clientDigits: string;              // '' = скрытый номер
  operatorRef: string;               // внутренний номер или логин у провайдера
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'missed' | 'busy' | 'no_answer' | 'cancelled' | 'failed';
  talkSec?: number; totalSec?: number;
  recording?: { ref: string; ready: boolean };
  correlationId?: string;
}
```

### 2.2. Режим `manual` (по умолчанию, к пилоту и навсегда как запасной)

1. «Позвонить» в PWA: `opId`, запись `pendingCall` в IndexedDB, открытие
   `tel:+7…` (обычная звонилка, iPhone и Android).
2. Возврат в приложение — шторка итога открывается сама.
3. Итог уходит через outbox в `POST /api/calls/outcomes`
   (`ARCHITECTURE.md` §7). `duration_source = manual_estimate`: время от нажатия
   до возврата, оператор может поправить.
4. «Итог без звонка из CRM» — для разговора с другого телефона (`via =
   manual_entry`), считается звонком с пометкой.
5. Входящих событий нет, записи нет. В отчётах длительность помечена как оценка.

### 2.3. Beeline ВАТС (`telephony.beeline`, флаг `FEATURE_TELEPHONY_BEELINE`)

К 1.11 — только заготовка в реестре: `healthCheck → not_configured`. Адаптер
пишется, когда ЦРП получит от Beeline документацию («API-файл» и настройки SIP).
Что известно: работает с корпоративными мобильными номерами Beeline, только с
казахстанских IP (наш сервер в РК), данные в РК.

Что нужно получить от Beeline письменно (до написания адаптера):
1. Способ click-to-call (callback или originate), поддержка «сначала клиент»,
   возврат id звонка в ответе.
2. События: вебхуки или XSI, формат, подпись или токен, IP-адреса отправителя,
   повторная доставка.
3. Записи: формат, срок хранения у провайдера, скачивание по API, удаление.
4. История звонков для ночной сверки.
5. Тестовый доступ (Beeline даёт 7 дней).

### 2.4. Zadarma (`telephony.zadarma`, флаг `FEATURE_TELEPHONY_ZADARMA`, `crossBorder: true`)

Код за выключенным флагом, проверен на фикстурах. Включается только после
письменного решения ЦРП о передаче ПДн за рубеж. Подлинность вебхука: заголовок
`Signature` = Base64(HMAC-SHA1(секрет, склейка полей)) по сырому телу,
`timingSafeEqual`, разрешённые IP провайдера, ответ на `zd_echo`. Режим
«сначала клиент» (`predicted`) по умолчанию. Записи скачиваются в РК и
удаляются у провайдера.

### 2.5. Вебхуки и сопоставление

- Адрес: `POST /api/hooks/telephony.<provider>/<token>` (§4).
- Ключ идемпотентности: `sha256(provider | type | externalCallId | стабильные поля)`.
- Слияние в `telephony_calls` upsert по `(integration_id, external_id)`: статус
  только вперёд (терминальный не заменяется нетерминальным), времена и
  длительности `COALESCE(новое, старое)`, пустой номер не затирает известный.
- Исходящий из CRM: «Позвонить» создаёт `call_intents(id = opId, card_id,
  user_id, client_digits, created_at)`. Событие сопоставляется по
  `correlationId`, если провайдер его возвращает, иначе по номеру и оператору в
  окне 120 секунд. Итог оператора с тем же `opId` получает
  `calls.telephony_call_id` и `duration_source = provider`.
- Входящий: номер известен → событие в ленту клиента; пропущенный → задача
  владельцу «Перезвонить (пропущенный)», `source_key = missed:<externalCallId>`.
  Номер неизвестен → новый клиент (источник `telephony`) через общий путь
  приёма (дедуп, стоп-лист, общая блокировка приёма), карточка по правилу
  входящих, задача. Номер у нескольких клиентов → клиент с последней
  активностью + задача РОП «проверить». Скрытый номер — строка звонка без
  клиента, отчёт «звонки без оператора/клиента».
- Неизвестный `operatorRef` — звонок с `user_id = NULL` в отчёте «Неразобранные».
- Ночная сверка `telephony-reconcile`: `listCalls` за 48 часов через тот же upsert.

### 2.6. Записи разговоров (после 1.11, по решению ЦРП о бюджете)

1. `recording.ready` ставит строку в `call_recordings(next_attempt_at = now + 40 с)`.
2. Воркер скачивает через `fetchRecording` в том `crm_recordings` на нашем
   сервере в РК, шифрует на диске, пишет `sha256`, размер, тип.
3. Повторы: 30 минут каждые 5 минут, потом каждые 6 часов, окно 14 дней.
4. После загрузки — удаление у провайдера, если API позволяет.
5. Отдача только через наш API с проверкой доступа к карточке и записью в аудит
   «кто слушал». Прямых ссылок провайдера клиенту нет.
6. Срок хранения — настройка интеграции; согласие и предупреждение о записи —
   `consents` и памятка оператора.

### 2.7. Таблицы телефонии (миграция вместе с первым живым адаптером)

`telephony_endpoints(integration_id, operator_ref, user_id, UNIQUE(integration_id, operator_ref))`,
`call_intents`, `telephony_calls(UNIQUE(integration_id, external_id), card_id,
client_id, user_id, direction, status, talk_sec, recording_ref, needs_review)`,
`call_recordings`. Для `manual` таблицы не нужны.

---

## 3. Мессенджеры

### 3.1. `messenger.wa_link` (по умолчанию)

Кнопка «Написать в WhatsApp» открывает `https://wa.me/<цифры>?text=<шаблон>`.
Шаблон — из `reminders.templates` с подстановками только из белого списка. В
ленту пишется «открыт WhatsApp, шаблон X» без текста переписки: это запись
(`note.write`, «только чтение» — 423, не больше 20 в минуту на сотрудника,
D-297). Посреднику ПДн не уходят.

### 3.2. `messenger.wazzup` (флаг `FEATURE_WAZZUP`, `crossBorder: true`)

Объём MVP (ступень 1 из разбора Wazzup):

| # | Что | Как |
|---|---|---|
| 1 | Подключение | администратор вставляет API-ключ клиента; проверка `GET /v3/channels`; показ каналов и состояний; привязка канала к оператору (`owner_user_id`) или к пулу; рекомендация — отдельный аккаунт Wazzup под CRM (подписка на вебхуки одна на аккаунт). Одно подключение на плагин; новые каналы приходят **выключенными** и включаются администратором, сообщения выключенного канала не принимаются; новый ключ выключает каналы прежнего аккаунта (D-298) |
| 2 | Вебхук | `PATCH /v3/webhooks` с **полным** объектом `subscriptions` (`messagesAndStatuses: true`, `channelsUpdates: true`, `contactsAndDealsCreation: false`, `templateStatus: false`), URL `https://<APP_ORIGIN>/api/hooks/messenger.wazzup/<token>`; на тестовый `{"test": true}` отвечаем 200 без записи |
| 3 | Пользователи | `POST /v3/users` при включении и при создании или переименовании сотрудника: id и имя (телефон — только если нужно мобильное приложение Wazzup) |
| 4 | Чат в карточке | `POST /api/messenger/chat-window/<cardId>` → проверка: пишущее действие `note.write` по карточке (`scopeSql`; «только чтение» и запирающая лицензия — 423, чужая — 404), согласие клиента не отозвано (иначе `409 consent_revoked`, провайдер не вызывается), интеграция включена → выбор канала (канал владельца, иначе общий) → `POST /v3/iframe` (`scope: card`, `filter` по номеру, `activeChat`) → ссылка отдаётся только этому пользователю, не кэшируется, не пишется в логи → панель с `<iframe allow="clipboard-write *">` без микрофона; аудит `messenger.open_chat` (D-297, D-299) |
| 5 | Входящее, номер известен | событие в ленту; задача владельцу «Ответить» (`source_key = reply:<chatId>`): пока она открыта, следующие входящие второй задачи не создают (ключ держит только открытая задача, `tasks_source_uq`); закрывается исходящим сообщением по тому же ключу; входящее после ответа — новая задача; `awaiting_reply = true`. **Состояние карточки событие мессенджера не меняет**: «Не интересует» или «Списан» возвращает в работу человек кнопкой в задаче (PROCESS 3.5, № 27) |
| 6 | Входящее, номер неизвестен | новый клиент (источник `whatsapp_in`) через общий путь приёма, карточка по правилу входящих (`distribution.inbound`), задача «Ответить»; лимит новых клиентов из мессенджера — 200 в сутки на подключение, задач по известным клиентам — 500 в сутки (защита от залива при утечке URL) |
| 7 | Клиент в «Не звонить» написал сам | сообщение в ленту, состояние не меняется, задача РОП (`dnc_inbound`) |
| 8 | Номер у нескольких клиентов | клиент с последней активностью + задача РОП «проверить» |
| 9 | Исходящие из iframe или телефона (`isEcho: true`) | в ленту; статусы `statuses[]` обновляют доставку |
| 10 | `missing_call` | событие в ленту, задача «Перезвонить (пропущенный WhatsApp)» |
| 11 | Здоровье канала | `channelsUpdates` с состоянием не `active` → уведомление администратору и РОП, бейдж канала |
| 12 | Согласие | отметка в карточке клиента «согласен на переписку и передачу данных за рубеж» → `consents` (хэш текста согласия); последняя отметка «отозвано» закрывает окно чата (D-297) |

**Подлинность вебхука Wazzup.** Подписи у Wazzup нет, поэтому проверка
складывается из нескольких слоёв: (1) токен 32 байта в пути URL (хранится
хэш; «Перевыпустить адрес» — §4 п. 7); (2) `crmKey` в настройке вебхука,
если API Wazzup позволит его задать, — сверка в заголовке; (3) `channelId`
каждого события должен принадлежать этому подключению; (4) лимиты из строк 6
и 5; (5) событие мессенджера никогда само не меняет состояние карточки и не
снимает «Не звонить» — только лента и задачи. Токен в пути виден
администраторам аккаунта Wazzup: это принятый остаточный риск, поэтому
рекомендован отдельный аккаунт Wazzup под CRM.

Обработка: приём сохраняет сырое событие в `webhook_inbox` с
`ON CONFLICT (integration_id, dedupe_key) DO NOTHING` и сразу отвечает 200.
Ключи: сообщение `m:<messageId>:<isEdited>:<isDeleted>`, статус
`s:<messageId>:<status>`, канал `c:<channelId>:<state>:<timestamp>`. Воркер:
`channelId` должен принадлежать этому подключению (телу не доверяем), upsert
сообщения по `(integration_id, provider_message_id)` — вебхук о нашем исходящем
может прийти раньше ответа API.

Отложено после 1.11: отправка текста из CRM (`POST /v3/message`), шаблоны
WABA, синхронизация контактов и сделок, глобальное окно и счётчик Wazzup
(свой счётчик `awaiting_reply` достаточен), вложения (в ленте — метка
«вложение»), Telegram и другие каналы.

CSP: `frame-src https://*.wazzup24.com` добавляется **только** при включённом
флаге. Полный список доменов, срок жизни ссылки iframe и работу микрофона в PWA
на iOS проверить на песочнице до включения.

Таблицы (по разбору Wazzup §9.3, без `org_id`; подключение и вебхуки — общие
`integrations` и `webhook_inbox`):

```sql
CREATE TABLE IF NOT EXISTS messenger_channels (
  id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, space_id TEXT NOT NULL,
  provider_channel_id TEXT NOT NULL, transport TEXT NOT NULL, plain_id TEXT,
  state TEXT NOT NULL DEFAULT 'unknown', state_changed_at BIGINT,
  owner_user_id TEXT, is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  UNIQUE (integration_id, provider_channel_id)
);
CREATE TABLE IF NOT EXISTS messenger_chats (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES messenger_channels(id),
  chat_type TEXT NOT NULL, chat_id TEXT NOT NULL,          -- WhatsApp: цифры номера
  client_id TEXT, last_inbound_at BIGINT, last_message_at BIGINT,
  awaiting_reply BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL,
  UNIQUE (channel_id, chat_type, chat_id)
);
CREATE INDEX IF NOT EXISTS messenger_chats_client_idx ON messenger_chats (client_id);
CREATE TABLE IF NOT EXISTS messenger_messages (
  id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, chat_ref TEXT NOT NULL REFERENCES messenger_chats(id),
  provider_message_id TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  msg_type TEXT NOT NULL, body TEXT, has_attachment BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT, author_user_id TEXT, is_edited BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE, sent_at BIGINT NOT NULL, status_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (integration_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messenger_messages_chat_idx ON messenger_messages (chat_ref, sent_at);
```

`payload` в `webhook_inbox` обнуляется через 14 дней. Срок хранения текста
сообщений — `[дозаполни: решение ЦРП и юриста]`, до решения хранится, удаляется
обезличиванием по запросу субъекта.

---

## 4. Приём вебхуков (общий маршрут)

`POST /api/hooks/<pluginId>/<token>`

1. Найти интеграцию по `sha256(token)` (токен 32 байта из CSPRNG, хранится
   только хэш). Нет или выключена → 404 (закрытый отказ, без подсказок).
2. Тело не больше 256 КБ; лимит частоты на интеграцию.
3. `plugin.webhook.verify()` — подпись (если провайдер её даёт), IP, токен,
   `crmKey`; для Wazzup — §3.2 «Подлинность». Неверно → 401, в метрики.
4. `INSERT INTO webhook_inbox … ON CONFLICT DO NOTHING` по каждому ключу
   `dedupeKeys()`; ответ 200 за миллисекунды (в том числе на повтор и на
   неподдерживаемое событие).
5. Воркер (цикл 5 секунд, `SKIP LOCKED`) разбирает `parse()` и применяет.
   Ошибка → `attempts+1`, повтор с задержкой; после 8 попыток (или сразу при
   ошибке настроек) `failed` и уведомление администраторам
   `integration_inbox_failed`, не чаще раза в сутки на подключение (D-298).
6. `integrations.last_event_at` показывается на странице интеграции: видно,
   что события идут.
7. Кнопка «Перевыпустить адрес» — мутация безопасности (D-054): старый токен
   перестаёт работать всегда. Включённое подключение с флагом и лицензией
   переподписывается (для Wazzup — повторный `PATCH /v3/webhooks`); иначе и
   при ошибке провайдера адрес обнуляется, подключение выключается, новый
   адрес выдаст следующее «Включить» (D-298).
8. nginx пишет путь `/api/hooks/<pluginId>/***` (токен маскируется в журнале).

---

## 5. API приёма лидов `ingest/v1`

Общий для продукта контракт для любых внешних источников базы: парсеров,
форм сайта, других систем. Источник для пользователей — подпись из
`sources.<key>.label` (у ЦРП «Новая база»).

### 5.1. Доступ

- Базовый путь: `/api/ingest/v1`. Снаружи закрыт, пока `INGEST_PUBLIC=0` (по
  умолчанию), двумя рубежами: nginx и приложение (D-155). Порт приложения
  доступен и из сети `crm_ingest`, поэтому заголовкам nginx (`X-Real-IP`,
  `X-Forwarded-For`, `X-Via-Proxy`) верят только вместе с `X-Proxy-Secret`,
  равным `CRM_PROXY_SECRET`. Запрос через nginx (верный секрет) проходит
  только при `INGEST_PUBLIC=1`, иначе получает 404. Запрос с меткой прокси,
  но без верного секрета — подделка, 404 всегда. Запрос без меток (внутренний
  источник по сети Docker) проходит; его адрес неизвестен, поэтому счётчик
  неудачных попыток ведётся по префиксу ключа, а не по адресу. Тесты — в
  `tests/integration/intake/`. Внутренние источники ходят по внешней сети
  Docker `crm_ingest` на псевдоним активного приложения
  `http://crm-app:3000/api/ingest/v1/…` (псевдоним переезжает на новый
  контейнер при обновлении, DEPLOY §5.2).
- Ключ: `Authorization: Bearer crm1_<prefix>_<secret>`; `prefix` — 8 символов
  `[a-z0-9]`, `secret` — 32 случайных байта в base64url. В БД:
  `ingest_keys(prefix, key_hash = sha256(secret), space_id, source_key, scopes,
  managed, revoked_at)`. Сравнение `timingSafeEqual`. Ключ показывается один раз.
- Разрешения ключа: `leads:write` (приём), `leads:demand` (потребность).
- Создание и отзыв: `crmctl ingest-key create --space <key> --source <key>
  --scopes leads:write,leads:demand --managed cli` и `crmctl ingest-key revoke
  <prefix>`. Ключи `managed=cli` в интерфейсе не показываются. Ключи
  `managed=ui` (для форм сайта и т. п.) администратор видит и отзывает в UI —
  после 1.11.
- Идемпотентность и узнавание записей привязаны к **источнику**
  (`source_key`), а не к id ключа: после ротации (новый ключ того же источника,
  старый отозван) повтор той же партии и тот же `externalId` узнаются
  (тест «ротация ключа → повтор записи даёт `merged`»).
- Подробный отчёт (статус каждой записи, `poolReady`) — только источнику с
  `sources[].detailedReport = true` (у ЦРП — «Новая база»). Остальным
  (формы сайта и чужие интеграторы) — только `accepted` или `invalid` по
  записи, без `poolReady`: иначе ответ — оракул «номер есть в базе».
- Лимиты: 60 запросов в минуту на ключ, тело до 2 МБ, до `intake.maxBatch`
  (1000) записей.
- `last_used_at` обновляется не чаще раза в минуту.

### 5.2. `POST /api/ingest/v1/leads`

Тело (`Content-Type: application/json`):

```json
{
  "batchId": "3b0f6c1e-6a52-4c0e-9b8a-2f1d7c9e4a10",
  "items": [
    {
      "externalId": "src-000123",
      "kind": "company",
      "name": "ТОО «Пример Строй»",
      "legalForm": "too",
      "orgId": "123456789012",
      "phones": ["8 709 123 4567", "+7 709 765 43 21"],
      "region": "Астана",
      "address": "",
      "email": "",
      "website": "",
      "custom": { "okved": "41.20", "registered_on": "2025-03-14" }
    }
  ]
}
```

| Поле | Тип | Правило |
|---|---|---|
| `batchId` | UUID | обязателен; ключ идемпотентности партии |
| `items` | массив 1…`maxBatch` | — |
| `externalId` | строка ≤ 100 | рекомендуется; стабильный id записи у источника: повтор в новой партии склеивается с прежним клиентом |
| `kind` | `company\|person` | по умолчанию `company` |
| `name` | строка 1–500 | обязательна |
| `legalForm` | ключ из `org.legalForms` или пусто | неизвестный ключ → пусто |
| `orgId` | строка | проверяется `org.idRule` (БИН — 12 цифр); не прошёл → поле отброшено и посчитано в `droppedFields.orgId`. У формы с `idIsPersonal` (ИП) 12 цифр — это ИИН: сразу HMAC в `iin_hmac`, открыто не хранится и не логируется (D-052) |
| `iin` | строка | только при `org.personIdRule = kz_iin_hmac`: сразу HMAC, открыто не хранится и не логируется; иначе отброшено |
| `phones` | 1–10 строк ≤ 40 символов | разбиваются, нормализуются, тип по префиксам; заглушки — нерабочие |
| `region`, `address` | строки ≤ 500 | обрезка пробелов, удаление управляющих символов |
| `email` | строка ≤ 254 | только адрес; иначе отброшено и посчитано в `droppedFields` (D-051) |
| `website` | строка ≤ 500 | только `http:`/`https:`; `javascript:`, `data:`, `vbscript:` и прочее отброшено и посчитано в `droppedFields` (D-051) |
| `contactName` | строка | принимается, только если `sources.<key>.allowPersonNames = true`; иначе отброшено и посчитано в `droppedFields` |
| `custom` | объект | только ключи полей с `ingest: true`; значения проверяет разбор по типу поля в `normalize.ts` (не годится — поле отброшено и посчитано); при `allowPersonNames = false` поля с `pii: person` отброшены; лишние ключи отброшены и посчитаны |

При `allowPersonNames = false` запись `kind: person` отклоняется целиком
(`invalid`, код `person_not_allowed`).

Обработка — одна транзакция на партию под общей блокировкой приёма:

1. Ключ, разрешение, лимиты, размер.
2. Проверка конверта (Zod). Ошибка конверта → 400 на всю партию.
3. Идемпотентность: строка `(source_key, batchId)` есть и `request_hash`
   (sha256 канонического тела) совпадает → вернуть сохранённый отчёт с
   `"replayed": true`, 200. Хэш другой → 409 `idempotency_conflict`.
4. Лицензия в `read_only`/`invalid`/`missing` или приём выключен → 423
   `not_accepting` (источник держит запас у себя).
5. По каждой записи — тот же путь, что у импорта (PROCESS 2.3):
   - ошибка полей записи → `invalid` (код без значений), не сохраняется;
   - сработало правило отклонения источника (`rejectRules`) → `rejected_rule`,
     **ничего не сохраняется**;
   - номера из стоп-листа отбрасываются; не осталось рабочих номеров не из
     стоп-листа → `stop_list`, **ничего не сохраняется**;
   - нет рабочего номера вообще → `no_working_phone`, не сохраняется;
   - `externalId` уже известен для этого источника, или совпал БИН, или
     совпали рабочий номер и название → `merged`: дописываются только пустые
     поля и новые номера; состояние карточки, владелец и итоги не меняются
     никогда;
   - общий номер при другом названии или название + руководитель → новый
     клиент + спорная пара → `held_pair` (в раздачу не идёт);
   - сработало правило задержки источника (`holdRules`) → `held_rule`;
   - иначе → `created`: клиент + карточка в пуле.
6. Раздачи при приёме нет: только тиком по расписанию (PROCESS 7.2).
7. Отчёт пишется в `ingest_batches.report` в той же транзакции.

Ответ 200 — только счётчики и статусы, ни одного номера, названия или поля:

```json
{
  "batchId": "3b0f6c1e-6a52-4c0e-9b8a-2f1d7c9e4a10",
  "replayed": false,
  "receivedAt": 1761609600000,
  "counts": { "received": 100, "created": 71, "merged": 9, "heldPair": 4, "heldRule": 2,
              "rejectedRule": 0, "stopList": 3, "noWorkingPhone": 8, "invalid": 3 },
  "droppedFields": { "contactName": 0, "iin": 0, "custom": 1, "orgId": 2 },
  "items": [
    { "index": 0,  "externalId": "src-000123", "status": "created" },
    { "index": 17, "externalId": "src-000140", "status": "invalid", "code": "name_required" }
  ],
  "poolReady": 312
}
```

`items` содержит строку на каждую запись партии в исходном порядке. Это
ответ при `detailedReport = true`; без него — `counts` только с `received`,
`accepted`, `invalid`, а в `items` статус `accepted` или `invalid`, без
`poolReady`.

### 5.3. `GET /api/ingest/v1/demand`

Сколько новых карточек нужно CRM. Только числа.

```json
{
  "asOf": 1761609600000,
  "timezone": "Asia/Almaty",
  "accepting": true,
  "maxBatch": 1000,
  "horizonWorkdays": 7,
  "today": { "date": "2026-10-28", "isWorkday": true, "operators": 10, "capPerOperator": 40,
             "capacity": 400, "issued": 120, "remaining": 280 },
  "days": [ { "date": "2026-10-29", "operators": 10, "capacity": 400 } ],
  "returnsExpected": 35,
  "poolReady": 312,
  "needToday": 0,
  "next": { "date": "2026-10-28", "capacity": 280, "returnsDue": 5 },
  "bufferDays": 0.5,
  "needNext": 103,
  "needTotal": 2733
}
```

Формулы (все по рабочему календарю и поясу установки):
- `operators(день)` — участники раздачи (`distribution.participantRoles`,
  членство активно, `in_distribution`), не отсутствующие в этот день; «Пауза»
  учитывается только для сегодня.
- `capacity(день) = operators × distribution.dailyCap`;
  `today.remaining = max(0, capacity − issued)`, где `issued` — выдачи,
  входящие в лимит, за местные сутки.
- `days` — следующие `intake.demandWorkdays` рабочих дней после сегодня.
- `returnsExpected` — карточки «Не интересует», у которых `return_at` наступает
  в горизонте (они занимают лимит раньше новых).
- `needToday = max(0, today.remaining − poolReady)` (0 в нерабочий день).
- `next` — ближайший рабочий день `D`: сегодня, если день рабочий и раздача по
  расписанию ещё не закончилась, иначе первый из `days`. `next.capacity` —
  `today.remaining` для сегодня или `capacity(D)`; `next.returnsDue` — возвраты
  с `return_at` до конца `D`.
- `needNext = max(0, ceil(next.capacity × (1 + intake.bufferDays)) −
  next.returnsDue − poolReady)` — **сколько источник отдаёт ночью** (D-057).
- `needTotal = max(0, today.remaining + Σ days.capacity − returnsExpected − poolReady)`
  — справочное число на горизонт; источник по нему не отправляет.
- `accepting = false` при лицензии `read_only`/`invalid`/`missing` или
  выключенном приёме.

### 5.4. Ошибки

Тело ошибки: `{ "error": { "code": "…", "message": "…", "issues": [ { "path": "items.3.phones", "code": "too_many" } ] } }`
— пути и коды, никаких значений.

| HTTP | `code` | Что делать источнику |
|---|---|---|
| 400 | `invalid_json`, `validation_failed` | исправить запрос, не повторять как есть |
| 401 | `unauthorized` | ключ неверен или отозван |
| 403 | `forbidden_scope` | у ключа нет разрешения |
| 409 | `idempotency_conflict` | тот же `batchId` с другим телом — ошибка источника |
| 413 | `payload_too_large` | уменьшить партию |
| 415 | `unsupported_media_type` | `Content-Type: application/json` |
| 423 | `not_accepting` | не слать, держать запас, повторить позже |
| 429 | `rate_limited` | ждать `Retry-After` |
| 500, 502, 503 | `internal`, `unavailable` | повторить **с тем же `batchId` и тем же телом** |

### 5.5. Версии

`v1` меняется только добавлением полей в ответы и необязательных полей в
запросы. Несовместимое изменение — `v2`; `v1` поддерживается не меньше
6 месяцев после выхода `v2`.

---

## 6. Контракт для источника лидов ЦРП

Источник ЦРП — отдельная программа владельца в отдельном приватном
репозитории и отдельном контейнере на том же сервере, со своей БД и ролью.
В продукте CRM её кода, экрана, настроек и журнала нет. Этот раздел — всё, на
что она может опираться.

1. **Сеть.** Свой compose-проект, подключён к внешней сети `crm_ingest`. Видит
   только `http://crm-app:3000`. Слушающих портов в `crm_ingest` у источника
   нет, поэтому CRM к нему подключиться не может. К сети `crm_internal` и к БД
   CRM доступа нет.
2. **Ключ.** Один ключ `managed=cli`, `source_key = new_base`, разрешения
   `leads:write` и `leads:demand`. Создаёт владелец командой `crmctl` **после
   ответа юриста** о законности сбора; до этого источник работает без отправки.
   Ключ хранится в окружении источника. В интерфейсе CRM не виден; отзыв —
   `crmctl ingest-key revoke`.
3. **Цикл.** Ночью (например, 01:00–05:00 по Алматы) запросить `demand`,
   отправить **не больше `needNext`** записей (потребность ближайшего рабочего
   дня плюс буфер `bufferDays`) партиями по `maxBatch` с новым UUID `batchId`
   на каждую партию. Свой запас на 7 рабочих дней источник держит у себя; CRM
   его не видит и не хранит (D-057, вопрос В-3 PLAN). В выходные `needNext`
   может быть 0 — это норма.
4. **Повторы.** Сеть, 429, 5xx → повтор того же `batchId` с тем же телом,
   задержка 1 с … 5 мин, не больше 10 попыток. 409 и 400 → не повторять, тревога
   владельцу. 423 → остановиться, держать запас, тревога владельцу.
5. **`externalId`.** Стабильный для компании (например, хэш БИН или id в
   реестре): повторная отправка той же компании не создаёт дубль.
6. **Поля до ответа юриста.** Только компании (ТОО), без `contactName`, без
   `iin`, без полей с ФИО. CRM это дублирует: у источника `new_base`
   `allowPersonNames = false` (отклоняет `kind: person` и отбрасывает поля
   `pii: person`) и правило **отклонения** ИП (`rejectRules`, ничего не
   сохраняется, D-052).
7. **Отчёты и тревоги** источник шлёт владельцу в Telegram сам, только числа
   (`demand`, отправлено, `counts`). ПДн в Telegram не уходят.
8. **Что видят пользователи CRM.** Источник «Новая база» у клиента и «запас
   в днях» у РОП (пул / ёмкость). Плитки «Поступило в пул за сутки» и тревоги
   «Новая база не поступала» у ЦРП нет (`reports.intakeTile = false`,
   `alerts.intakeStaleHours = null`, D-056, вопрос В-3 PLAN): тревоги о
   поступлении получает только владелец из Telegram источника.
   `ingest_batches` хранится 30 дней. Слов «парсер» и «сборщик» в
   интерфейсе, локалях, ответах API и журналах CRM нет.
9. **Честная граница (вопрос В-4 PLAN).** root сервера ЦРП видит контейнеры и
   таблицы `ingest_keys`, `ingest_batches` CRM, а также **может открыть
   контейнер источника**: `docker exec`, дамп его БД (запас базы),
   окружение (доступы к порталу, токен Telegram, ключ приёма) и бинарник
   Nuitka. Технически это не закрывается, пока источник стоит на сервере
   ЦРП. Смягчение: источник держит в своей БД минимум и удаляет отправленное
   после подтверждения CRM; секреты — в файле окружения 0600 своего проекта;
   своя лицензия источника с коротким сроком; слушающих портов нет. Полное
   закрытие — только источник на сервере владельца в РК, который ходит в CRM
   по HTTPS с ключом (тогда `INGEST_PUBLIC=1` с ограничением по IP).

---

## 7. Секреты

| Секрет | Где хранится | Кто видит |
|---|---|---|
| Пароли БД `crm_owner`, `crm_app` | `/etc/crm/*.env` (root, 0600) | root сервера |
| `CRM_SECRETS_KEY_<kid>` (AES-256-GCM) | окружение; копия вне сервера (PLAN §9 В-22) | root |
| `CRM_PHONE_HMAC_KEY`, `CRM_IIN_HMAC_KEY` | окружение; копия вне сервера | root |
| API-ключи провайдеров (Wazzup, Zadarma, Beeline) | `integration_secrets`: AES-256-GCM, случайный IV 12 байт, AAD = `integration_id|name|kid` | расшифровка только внутри вызова плагина |
| Токены вебхуков, ключи приёма, токены сессий и приглашений | только sha256 в БД | никто, показываются один раз |
| VAPID private | окружение | root |
| Закрытый ключ лицензий, ключ подписи релизов | только у владельца офлайн, не в репозитории и не в CI-секретах; клиентские пакеты владелец подписывает у себя (D-064) | владелец |
| Ключ `stage` | секрет CI; ему доверяет только `crmctl` стенда, боевой `crmctl` его не принимает | CI |
| Закрытые ключи age для бэкапов | только у хранителей, на сервере — открытые | хранители |

Правила:
- Ключ шифрования не лежит в БД и не попадает в её бэкап. Утечка дампа не
  раскрывает секреты интеграций.
- Ротация: новый `kid` → `crmctl secrets rotate` перешифровывает все записи →
  старый ключ удаляется после проверки.
- В UI секрет показывается как «задан, …последние 4 символа».
- В логах нет секретов, номеров (маска), текстов сообщений, ссылок iframe,
  токенов в путях (маска в nginx).
- Честная граница: root сервера читает окружение. Шифрование защищает от утечки
  дампа и бэкапа, а не от владельца сервера.

---

## 8. Исходящие соединения CRM

По умолчанию CRM в интернет не ходит. Исключения:
- включённые плагины — только на хосты своего провайдера
  (`api.wazzup24.com` и т. п.);
- web-push — на серверы push Apple и Google. Поэтому в тексте push нет имён
  клиентов, номеров и названий компаний: только вид события и числа;
- телеметрии нет (`TELEMETRY=off`). Технический healthcheck работает на хосте и
  шлёт в Telegram только статусы, без ПДн.
