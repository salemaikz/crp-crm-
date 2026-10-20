// Контракт встроенных плагинов интеграций (INTEGRATIONS §1–3, D-024, дизайн docs/reports-plugins-design.md §7–8,
// решения D-268…D-271). СИГНАТУРЫ: меняются только через architect. Реализации — src/integrations/<kind>/<plugin>/,
// реестр — src/integrations/registry.ts. Домен видит только этот файл (ESLint, tests/unit/layers.test.ts):
// плагин попадает в домен через PluginRegistry в deps, который собирают маршрут или задача воркера.
//
// Правила:
// - плагин не ходит в БД и не знает домен: получает Ctx, возвращает нормализованные события или коды;
// - секреты расшифровываются только внутри вызова плагина (ctx.secrets()), не логируются и не возвращаются;
// - в коде ошибок и логах нет номеров, текстов сообщений, ключей и ссылок iframe;
// - parse() — чистая функция: тесты на фикстурах tests/integrations/<pluginId>/fixtures/*.json.
import type { ZodType } from 'zod';

/** Все плагины продукта. Новый провайдер = новая строка здесь, файл плагина и строка в registry.ts. */
export const PLUGIN_IDS = ['telephony.manual', 'telephony.beeline', 'telephony.zadarma', 'messenger.wa_link', 'messenger.wazzup'] as const;
export type PluginId = (typeof PLUGIN_IDS)[number];
export type PluginKind = 'telephony' | 'messenger';

/** Имя флага окружения без префикса FEATURE_ (src/server/platform/flags.ts FEATURES). */
export type PluginFlag = 'WAZZUP' | 'TELEPHONY_ZADARMA' | 'TELEPHONY_BEELINE';

/** HTTP наружу: подменяется в тестах фикстурами. Таймаут по умолчанию 10 с (AbortSignal.timeout). */
export interface PluginHttp {
  fetch: (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>;
}

/**
 * Контекст вызова. `integrationId` — строка `integrations` (null у плагинов без подключения: manual, wa_link).
 * `secrets()` расшифровывает при каждом вызове (кэша нет): ключ живёт только на время вызова.
 */
export interface Ctx<C, S> {
  integrationId: string | null;
  spaceId: string | null;
  config: C;
  secrets: () => Promise<S>;
  http: PluginHttp;
  /** Нормализованный APP_ORIGIN: адрес вебхука строится из него. */
  appOrigin: string;
  now: number;
}

/** Сырой запрос вебхука: тело уже прочитано с пределом 256 КБ (INTEGRATIONS §4 п. 2). */
export interface RawRequest {
  method: string;
  headers: { get(name: string): string | null };
  body: Uint8Array;
  /** JSON тела или undefined, если тело не JSON. */
  json: unknown;
}

/**
 * Итог проверки подлинности. `test` — служебный запрос провайдера при подписке (Wazzup `{"test": true}`):
 * ответ 200 без записи (D-270). `bad_*` → 401 без подробностей.
 */
export type VerifyResult = { ok: true; test: boolean } | { ok: false; code: 'bad_auth' | 'bad_body' };

/** Одна строка webhook_inbox: ключ идемпотентности, вид и свой кусок тела (одна строка = одно событие провайдера). */
export interface InboxItem {
  /** ≤ 200 символов, без номеров и текстов: `m:<messageId>:<isEdited>:<isDeleted>`, `s:<messageId>:<status>`, … */
  dedupeKey: string;
  kind: 'message' | 'status' | 'channel' | 'call';
  payload: unknown;
}

// ---------------------------------------------------------------------------
// Нормализованные события: домен знает только их (INTEGRATIONS §1)
// ---------------------------------------------------------------------------

export type MessengerMessageType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'missing_call' | 'other';
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'error' | 'inbound';

export interface MessengerMessageEvent {
  type: 'message';
  /** Id канала у провайдера: домен сверяет его с messenger_channels этого подключения (телу не доверяем). */
  channelRef: string;
  chatType: string;
  /** Id чата у провайдера (у WhatsApp — цифры номера). */
  chatId: string;
  /** Цифры номера клиента с кодом страны или '' (чат не по номеру). */
  chatDigits: string;
  providerMessageId: string;
  direction: 'in' | 'out';
  msgType: MessengerMessageType;
  /** Текст ≤ 4096 символов или null (вложение, системное, удалённое). */
  text: string | null;
  hasAttachment: boolean;
  status: DeliveryStatus | null;
  /** Id автора исходящего у провайдера (= users.id CRM, если писали из окна CRM) или null. */
  authorRef: string | null;
  sentAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  /** Имя контакта у провайдера ≤ 200 (только для имени нового клиента) или null. */
  contactName: string | null;
}

export interface MessengerStatusEvent {
  type: 'status';
  providerMessageId: string;
  status: DeliveryStatus;
  at: number;
}

export interface MessengerChannelEvent {
  type: 'channel';
  channelRef: string;
  /** Нижний регистр; здоровым считается только 'active' (незнакомое — нездоровое). */
  state: string;
  at: number;
}

export interface CallEvent {
  type: 'call';
  event: 'call.initiated' | 'call.answered' | 'call.ended' | 'recording.ready';
  externalCallId: string;
  occurredAt: number;
  direction: 'outbound' | 'inbound';
  /** '' — скрытый номер. */
  clientDigits: string;
  operatorRef: string;
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'missed' | 'busy' | 'no_answer' | 'cancelled' | 'failed';
  talkSec?: number;
  totalSec?: number;
  recording?: { ref: string; ready: boolean };
  correlationId?: string;
}

export type NormalizedEvent = MessengerMessageEvent | MessengerStatusEvent | MessengerChannelEvent | CallEvent;

// ---------------------------------------------------------------------------
// Плагин
// ---------------------------------------------------------------------------

export type HealthCode = 'ok' | 'not_configured' | 'auth' | 'provider_down' | 'no_channels';

export interface Plugin<C, S> {
  id: PluginId;
  kind: PluginKind;
  version: number;
  /** Нет флага — плагин всегда разрешён кодом (manual, wa_link). */
  flag?: PluginFlag;
  /** Признак в лицензии (`features`); нет — лицензия не нужна. */
  licenseFeature?: string;
  /** Данные уходят за рубеж: включение требует отметки решения о передаче ПДн (D-270). */
  crossBorder: boolean;
  /** Нужна ли строка integrations (подключение администратором). manual и wa_link — нет. */
  needsConnection: boolean;
  configSchema: ZodType<C>;
  secretsSchema: ZodType<S>;
  healthCheck(ctx: Ctx<C, S>): Promise<{ ok: boolean; code: HealthCode }>;
  webhook?: {
    /** Ничего не пишет в БД. Токен пути уже проверен общим маршрутом (по хэшу). */
    verify(ctx: Ctx<C, S>, req: RawRequest): VerifyResult;
    /** Разбить тело на строки inbox (ключи идемпотентности). Пустой массив — нечего сохранять (ответ 200). */
    split(ctx: Ctx<C, S>, req: RawRequest): InboxItem[];
    /** Чистая функция: payload строки inbox → события. Неизвестное — пустой массив, не ошибка. */
    parse(kind: InboxItem['kind'], payload: unknown): NormalizedEvent[];
  };
}

export type InitiateCallResult =
  | { kind: 'tel'; href: string }
  | { kind: 'started'; externalCallId?: string }
  | { kind: 'error'; code: 'bad_number' | 'no_endpoint' | 'auth' | 'limit' | 'provider_down' | 'rejected' };

export interface TelephonyPlugin<C = unknown, S = unknown> extends Plugin<C, S> {
  kind: 'telephony';
  capabilities: {
    clickToCall: 'tel' | 'callback' | 'originate';
    clientFirst: boolean;
    webhooks: boolean;
    recordings: 'none' | 'link' | 'stream';
    listCalls: boolean;
    returnsCallIdOnInitiate: boolean;
  };
  initiateCall(
    ctx: Ctx<C, S>,
    input: { userId: string; operatorRef?: string; clientDigits: string; ext?: string; mode: 'operator-first' | 'client-first'; correlationId: string },
  ): Promise<InitiateCallResult>;
}

export interface MessengerChannelInfo {
  channelRef: string;
  transport: string;
  /** Номер или логин канала компании (не клиента). */
  plainId: string | null;
  state: string;
}

export type OpenChatResult = { kind: 'link'; href: string } | { kind: 'iframe'; url: string } | { kind: 'error'; code: 'not_configured' | 'auth' | 'provider_down' | 'rejected' };

export interface MessengerPlugin<C = unknown, S = unknown> extends Plugin<C, S> {
  kind: 'messenger';
  capabilities: { chat: 'link' | 'iframe'; inbound: boolean; channels: boolean };
  /**
   * Открыть чат с клиентом. `link` — ссылка (wa.me), `iframe` — одноразовая ссылка окна провайдера: отдаётся только
   * этому пользователю, не кэшируется и не пишется в логи. Имя клиента провайдеру не передаётся (D-270).
   */
  openChat(
    ctx: Ctx<C, S>,
    input: { user: { id: string; name: string }; chat: { chatType: string; chatId: string; digits: string }; channelRef: string | null; text: string | null },
  ): Promise<OpenChatResult>;
  listChannels?(ctx: Ctx<C, S>): Promise<{ ok: true; channels: MessengerChannelInfo[] } | { ok: false; code: HealthCode }>;
  /** Подписка на вебхуки (полный объект подписок) по адресу `${appOrigin}/api/hooks/<pluginId>/<token>`. */
  subscribe?(ctx: Ctx<C, S>, input: { webhookUrl: string }): Promise<{ ok: true } | { ok: false; code: HealthCode | 'rejected' }>;
  /** Сотрудники у провайдера (id = users.id, имя). Только после отметки решения о передаче за рубеж. */
  syncUsers?(ctx: Ctx<C, S>, users: readonly { id: string; name: string }[]): Promise<{ ok: true } | { ok: false; code: HealthCode }>;
}

export type AnyPlugin = TelephonyPlugin | MessengerPlugin;

/**
 * Можно ли пользоваться плагином сейчас (CONFIG §8, D-268): флаг ∧ лицензия ∧ подключение включено ∧
 * (зарубежный → отметка решения). Чистая функция, реализация — src/integrations/enablement.ts.
 */
export interface PluginGate {
  flagOn: boolean;
  licensed: boolean;
  /** integrations.enabled; для плагинов без подключения — true. */
  enabled: boolean;
  crossBorderApproved: boolean;
}
export type PluginUsability =
  | { usable: true }
  | { usable: false; reason: 'flag_off' | 'not_licensed' | 'disabled' | 'crossborder_not_approved' };
export type PluginUsabilityOf = (plugin: Pick<AnyPlugin, 'flag' | 'licenseFeature' | 'crossBorder' | 'needsConnection'>, gate: PluginGate) => PluginUsability;

/** Реестр, который домен получает в deps (домен не импортирует registry.ts). */
export interface PluginRegistry {
  get(id: PluginId): AnyPlugin | null;
  telephony(id: PluginId): TelephonyPlugin | null;
  messenger(id: PluginId): MessengerPlugin | null;
  all(): readonly AnyPlugin[];
}

/** Как интерфейс звонит и пишет клиенту (D-268): сервер решает по реестру, клиент строит ссылку сам. */
export interface ChannelModes {
  telephony: { pluginId: PluginId; clickToCall: 'tel' | 'callback' | 'originate' };
  messenger: { pluginId: PluginId; chat: 'link' | 'iframe' };
}
