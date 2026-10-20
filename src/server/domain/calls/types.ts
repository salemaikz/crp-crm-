// Итоги звонков, пропуски, очередь «Звонить» и счётчик неотправленных с устройства (C5). Дизайн —
// docs/calls-design.md, решения D-175, D-177, D-178. Здесь только типы и сигнатуры; тела пишет builder
// в outcomes.ts, skips.ts, queue.ts, device.ts, repo.ts, deps.ts; маршруты — src/app/api/calls/**.
//
// Правила модуля:
// - итог идемпотентен по opId (calls.id), пропуск — по opId (skips.id); повтор отвечает прежним итогом;
// - карточка блокируется первой (cards/types.ts), повтор opId проверяется уже под блокировкой;
// - отклонение ядра (`rejected`) откатывает всю транзакцию, включая запись «Договорились»;
// - ответ без ПДн, кроме очереди (проекция полей по правам, номера своей карточки).
import type { calling } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { BookingDeps, GroupBookingRequest, IndividualBookingRequest } from '@/server/domain/booking/types';
import type { LoadCallingContext, QueueGroup } from '@/server/domain/cards/types';

// ---------------------------------------------------------------------------
// Итог
// ---------------------------------------------------------------------------

/** Каналы итога с устройства. `manual_entry` (РОП вносит за оператора) и `telephony` — позже. */
export const OUTCOME_VIAS = ['ui', 'offline'] as const;
export type OutcomeVia = (typeof OUTCOME_VIAS)[number];

export interface LprInfo {
  name: string;
  phone: string;
  when: string;
}

/** «Договорились — записать»: только онлайн, одна транзакция «итог + запись + сделка» (D-019, PROCESS 12.7). */
export interface OutcomeAgreement {
  contactId: string | null;
  /** Договорённость с датой без записи (`calling` создаст задачу `agreement:<opId>`). */
  agreedDueAt: number | null;
  /** Запись в той же транзакции: requestId = opId. Индивидуальная (БК) — после B3a, модель уже допускает. */
  booking: OutcomeBookingRequest | null;
}

/** Запись из шторки: requestId, clientId и contactId подставляет сервер (opId, клиент карточки, контакт). */
export type OutcomeBookingRequest =
  | Omit<GroupBookingRequest, 'requestId' | 'clientId' | 'contactId'>
  | Omit<IndividualBookingRequest, 'requestId' | 'clientId' | 'contactId'>;

/** Тело POST /api/calls/outcomes (Zod .strict() в маршруте). Время — epoch-мс устройства. */
export interface OutcomeRequest {
  opId: string;
  cardId: string;
  outcomeKey: string;
  via: OutcomeVia;
  occurredAt: number;
  tappedAt: number | null;
  /** Номер разговора (id client_phones). Обязателен для `bad_number` и для стоп-листа `do_not_call`. */
  phoneId: string | null;
  reasonCode: string;
  /** ≤ 2000 символов. */
  note: string;
  lpr: calling.Lpr;
  lprInfo: LprInfo | null;
  callbackAt: number | null;
  markTarget: boolean;
  alsoDncPhoneIds: string[];
  /** Только ключи `requires.fields[]` итога; иначе 400 `field_not_allowed`. */
  fields: Record<string, unknown>;
  /** Оценка длительности оператором, секунды (manual_estimate). */
  durationSec: number | null;
  agreement: OutcomeAgreement | null;
}

export interface OutcomeCardView {
  id: string;
  state: calling.CardState;
  version: number;
  nextCallAt: number | null;
}

/** Ответ 200. `card` = null, если карточка больше не видна оператору (передана: `owner_changed`). */
export interface OutcomeResponse {
  status: 'applied' | 'fact_only' | 'duplicate';
  applied: 'applied' | 'fact_only';
  factReason: calling.FactReason;
  warnings: calling.Warning[];
  card: OutcomeCardView | null;
  bookingId: string | null;
}

export interface CallsDeps {
  context: LoadCallingContext;
  booking: () => BookingDeps;
  now: () => number;
}

export type SubmitOutcome = (deps: CallsDeps, viewer: Viewer, req: OutcomeRequest) => Promise<OutcomeResponse>;

// ---------------------------------------------------------------------------
// Пропуск
// ---------------------------------------------------------------------------

export interface SkipRequest {
  opId: string;
  cardId: string;
}

export interface SkipResponse {
  status: 'skipped' | 'duplicate';
  skipsToday: number;
  skipLimit: number;
}

/** Пропуск: под блокировкой пропусков сотрудника (SKIP_LOCK_CLASS) — 12 одновременных дают ровно лимит. */
export type SubmitSkip = (deps: CallsDeps, viewer: Viewer, req: SkipRequest) => Promise<SkipResponse>;

/** Класс (первое int4) блокировки пропусков сотрудника: pg_advisory_xact_lock(SKIP_LOCK_CLASS, hashtext(userId)). */
export const SKIP_LOCK_CLASS = 72_026_105;

// ---------------------------------------------------------------------------
// Очередь «Звонить» (PROCESS 2.5, 7.4; D-177)
// ---------------------------------------------------------------------------

export interface QueueQuery {
  /** 1 — одна карточка; до 4 — текущая и три следующие (память страницы, ARCHITECTURE §7). */
  limit: number;
  /** Карточки с итогом в outbox устройства (≤ 50): сервер их ещё видит к звонку, устройство — нет. */
  exclude: readonly string[];
  group: QueueGroup | 'all';
}

export interface QueuePhone {
  id: string;
  /** Полные цифры: нужны для `tel:` своей карточки. Номера из стоп-листа и нерабочие не отдаются. */
  digits: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isPrimary: boolean;
}

export interface QueueCard {
  cardId: string;
  clientId: string;
  version: number;
  state: calling.CardState;
  group: QueueGroup;
  /** Пропущена сегодня: стоит в конце очереди. */
  skippedToday: boolean;
  name: string;
  attempts: number;
  lastOutcomeCode: string;
  lastOutcomeAt: number | null;
  nextCallAt: number | null;
  lpr: calling.Lpr;
  isTarget: calling.Target;
  phones: QueuePhone[];
  /** Поля клиента и карточки по правам (`projectFor`), как в карточке клиента C2. */
  fields: Record<string, unknown>;
}

export interface QueueCounts {
  /** К звонку сейчас: наступившие перезвоны и повторы + новые. */
  dueNow: number;
  /** Перезвоны, просроченные больше чем на `tasks.overdueAlertMinutes`. */
  overdue: number;
  callbacks: number;
  retries: number;
  /** «Возвращённые» (C6c, неделя 2): до неё 0. */
  returns: number;
  new: number;
  skippedToday: number;
  skipLimit: number;
}

export interface QueueResponse {
  counts: QueueCounts;
  items: QueueCard[];
}

export type GetQueue = (deps: CallsDeps, viewer: Viewer, q: QueueQuery) => Promise<QueueResponse>;

// ---------------------------------------------------------------------------
// Устройство (D-063, D-178)
// ---------------------------------------------------------------------------

export const DEVICE_HEADERS = {
  deviceId: 'x-device-id',
  pending: 'x-outbox-pending',
  lastFlush: 'x-outbox-last-flush',
} as const;

export interface DeviceReport {
  /** Случайный id из IndexedDB, 1–64 символа [A-Za-z0-9_-]. */
  deviceId: string;
  /** 0–10 000. */
  pending: number;
  lastFlushAt: number | null;
}

/** Разбор заголовков; нет X-Device-Id или мусор — null (запрос не ломается). */
export type ParseDeviceHeaders = (headers: Headers) => DeviceReport | null;

/** UPSERT device_status (user_id, device_id) вне транзакции итога; ошибка — только в лог. */
export type RecordDeviceStatus = (viewer: Viewer, report: DeviceReport, now: number) => Promise<void>;

// ---------------------------------------------------------------------------
// Ошибки (HTTP — docs/calls-design.md §8)
// ---------------------------------------------------------------------------

export const CALLS_DOMAIN_ERRORS = ['field_not_allowed', 'phone_not_on_card', 'invalid_settings', 'opid_reused'] as const;
export type CallsErrorCode = calling.RejectCode | (typeof CALLS_DOMAIN_ERRORS)[number];

export interface CallsFailure {
  code: CallsErrorCode;
  /** Поле тела, к которому относится ошибка проверки (из ядра `rejected.field`). */
  field: string | null;
}
