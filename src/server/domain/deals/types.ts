// Сделки и покупки (B6): сигнатуры. Дизайн — docs/deals-handoffs-design.md §5, решения D-248…D-250.
// Тела — builder в settings.ts, rules.ts (чистые), purchase.ts, stage.ts, read.ts, stale.ts, repo.ts, effects.ts.
// Меняются только через architect.
//
// Правила модуля:
// - деньги — целые тенге (`amount_kzt` BIGINT, в JS number ≤ 1e12), никаких дробей и float-арифметики;
// - действие со сделкой: блокировка карточки → сделки → (передачи); идемпотентность — `client_events.id` = opId/requestId;
// - сервис сам пишет сделку, затем событие карточки через CardPort; эффект ядра по уже записанной сделке — пустой (D-248);
// - строки сделок и карточек — только через scopeSql (deal — через карточку).
import type { calling, time } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { BookingView, CardPort } from '@/server/domain/booking/types';

export type DealStatus = 'open' | 'won' | 'lost';

/** Этап воронки целиком (CONFIG §6.8). `PipelineStage` из pipelines.ts — его подмножество для записи. */
export interface DealStageInfo {
  key: string;
  label: { ru: string; kk?: string };
  kind: DealStatus;
  order: number;
  requires: { fields: string[]; booking: boolean; attendance: boolean; nextTask: boolean; amount: boolean; serviceType: boolean; reason: boolean };
  /** Срок «залежалось», календарные дни от смены этапа (D-244); null — не следим. */
  staleDays: number | null;
  auto: 'on_agreed' | 'on_attended' | null;
}

export interface DealPipelineInfo {
  key: string;
  label: { ru: string; kk?: string };
  createDealOn: 'agreed' | 'client_created' | 'manual';
  /** Действующие этапы в порядке `order`. */
  stages: DealStageInfo[];
}

export interface ServiceTypeInfo {
  key: string;
  label: { ru: string; kk?: string };
  /** Ключ отдела (`teams[].key`) для передачи; null — без передачи. */
  routeToTeam: string | null;
}

export interface LostReasonInfo {
  key: string;
  label: { ru: string; kk?: string };
  softness: 'soft' | 'hard';
  needsText: boolean;
}

export interface DealsSettings {
  spaceId: string;
  timeZone: string;
  calendar: time.WorkCalendar;
  /** `calendar.workHours.end` — срок передачи «до конца рабочего дня». */
  workHoursEnd: string;
  /** `calendar.callWindow.start` — срок задачи исполнителю передачи (B6b): следующий рабочий день с этого часа. */
  callWindowStart: string;
  pipelines: DealPipelineInfo[];
  /** Только не архивные. */
  serviceTypes: ServiceTypeInfo[];
  /** `reasons.deal_lost`. */
  lostReasons: LostReasonInfo[];
  /** `deals.purchaseFutureLimitHours`: дата покупки не позже «сейчас + N ч». */
  purchaseFutureLimitHours: number;
  /** `handoff.acceptSlaWorkdays`. */
  acceptSlaWorkdays: number;
  /**
   * Подписи всех полей сделки (`fields[]`, `object: 'deal'`) по ключу, без учёта роли. Клиенту — только через
   * `stageFieldLabelsFor` (поля требований этапов, видимые зрителю).
   */
  fieldLabels: Record<string, { ru: string; kk?: string }>;
}

export type LoadDealsSettings = (spaceId: string, now: number) => Promise<DealsSettings>;

/** События карточки, которые порождают сделки (PROCESS 3.5 № 19–21). Принимает тот же CardPort (D-248). */
export type DealCardEvent = calling.PurchaseEvent | calling.PurchaseCancelledEvent | calling.DealLostEvent;

export interface DealsDeps {
  /** Тот же порт карточки, что у записи (cards/bookingPort.ts); союз событий расширен в booking/types.ts. */
  cards: CardPort;
  settings: LoadDealsSettings;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Проекции
// ---------------------------------------------------------------------------

export interface DealView {
  id: string;
  pipelineKey: string;
  stageKey: string;
  status: DealStatus;
  clientId: string;
  cardId: string;
  ownerUserId: string | null;
  serviceTypeKey: string;
  /** Целые тенге; null — сумма скрыта: зритель видит сделку только как отдел передачи (D-300). */
  amountKzt: number | null;
  wonAt: number | null;
  lostAt: number | null;
  lostReasonCode: string;
  needsRebook: boolean;
  stageChangedAt: number;
  /** Сколько дней залежалась на текущем этапе; null — у этапа нет `staleDays` или срок не прошёл. */
  staleDays: number | null;
  version: number;
  createdAt: number;
}

/** Событие истории сделки (лента клиента с фильтром по сделке, PROCESS 4.5): коды и числа. */
export interface DealHistoryItem {
  id: string;
  kind: string;
  at: number;
  actorName: string | null;
  data: Record<string, unknown>;
}

export interface DealPageView {
  deal: DealView;
  clientName: string;
  ownerName: string | null;
  pipeline: DealPipelineInfo;
  history: DealHistoryItem[];
  bookings: BookingView[];
  handoff: { id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled'; teamKey: string } | null;
  /** Что показать в интерфейсе; сервер всё равно проверяет каждое действие. */
  can: { purchase: boolean; editStage: boolean; moveBack: boolean; lose: boolean; editPurchase: boolean };
}

export type GetDealPage = (deps: DealsDeps, viewer: Viewer, dealId: string) => Promise<DealPageView>;

/** Форма покупки по карточке: открытые сделки клиента и типы услуг. */
export interface PurchaseFormView {
  cardId: string;
  clientId: string;
  clientName: string;
  cardState: calling.CardState;
  /** false — карточка не в `agreed`/`callback`/`client`: «Сначала итог «Договорились»». */
  allowed: boolean;
  openDeals: Pick<DealView, 'id' | 'stageKey' | 'version' | 'createdAt'>[];
  /** Сделка по умолчанию: единственная открытая в воронке записи; иначе null («Новая сделка»). */
  defaultDealId: string | null;
  serviceTypes: { key: string; label: string; routesToTeam: boolean }[];
  today: string;
  timeZone: string;
}

export type GetPurchaseForm = (deps: DealsDeps, viewer: Viewer, input: { cardId: string; locale: string }) => Promise<PurchaseFormView>;

// ---------------------------------------------------------------------------
// Действия
// ---------------------------------------------------------------------------

export interface PurchaseInput {
  /** UUID из формы, живёт до успеха. Ключ — `client_events.id` события `deal.won` и `deals.request_id` новой сделки. */
  requestId: string;
  cardId: string;
  /** Открытая сделка клиента; null — новая сделка сразу на этапе «Покупка» (PROCESS 4.1 п. 2, 4.3). */
  dealId: string | null;
  serviceTypeKey: string;
  /** Ключ живого варианта типа услуги (D-357); нет — сделка без варианта (`''`). Сумму вариант не проверяет (скидка). */
  variantKey?: string | undefined;
  /** Целое ≥ 0, ≤ 1e12. */
  amountKzt: number;
  /** Местная дата покупки; день = 12:00 местного времени; null — сейчас. */
  wonDay: string | null;
}

export interface PurchaseResult {
  deal: DealView;
  /** Передача в отдел, если тип услуги её требует. */
  handoffId: string | null;
  replayed: boolean;
}

export type RegisterPurchase = (deps: DealsDeps, viewer: Viewer, input: PurchaseInput) => Promise<PurchaseResult>;

/** Правка суммы и даты выигранной сделки (РОП, `deal.move_back`); тип услуги так не меняется (D-249). */
export interface EditPurchaseInput {
  dealId: string;
  opId: string;
  version: number;
  amountKzt?: number;
  wonDay?: string;
  /** Вариант услуги сделки (D-357); проверяется по типу услуги самой сделки. */
  variantKey?: string | undefined;
}

export type EditPurchase = (deps: DealsDeps, viewer: Viewer, input: EditPurchaseInput) => Promise<DealView>;

/** Отмена покупки (PROCESS 3.5 № 20, 12.29): `refund` → «Проигран: возврат», `error` → прежний открытый этап. */
export interface CancelPurchaseInput {
  dealId: string;
  opId: string;
  version: number;
  mode: 'refund' | 'error';
  comment: string;
}

export type CancelPurchase = (deps: DealsDeps, viewer: Viewer, input: CancelPurchaseInput) => Promise<DealView>;

export interface NextStepInput {
  /** Не раньше «сейчас − 5 мин». */
  dueAt: number;
  kind: 'call' | 'meeting';
}

/** Ручной перенос на открытый этап: вперёд — `deal.edit`, назад — ещё и `deal.move_back` (PROCESS 4.2). */
export interface MoveStageInput {
  dealId: string;
  opId: string;
  version: number;
  stageKey: string;
  /** Обязателен, если у этапа `requires.nextTask` и открытой задачи со сроком по сделке нет. */
  nextStep: NextStepInput | null;
  /**
   * Значения обязательных полей этапа из панели доски (B8): проверяет `buildFieldValidator` в той же транзакции
   * и пишет в `deals.custom`; ключи — только поля объекта `deal`, доступные роли на правку.
   */
  fieldsPatch?: Record<string, unknown>;
}

export type MoveDealStage = (deps: DealsDeps, viewer: Viewer, input: MoveStageInput) => Promise<DealView>;

/** «Проигран» (PROCESS 3.5 № 21): причина из `reasons.deal_lost`; для `needsText` — текст 1–500. */
export interface LoseDealInput {
  dealId: string;
  opId: string;
  version: number;
  reasonCode: string;
  reasonText: string;
}

export type LoseDeal = (deps: DealsDeps, viewer: Viewer, input: LoseDealInput) => Promise<DealView>;

/** Для тревоги РОП «Сделки залежались» (alarms, поток manager): только число. */
export type CountStaleDeals = (input: { spaceId: string; now: number; pipelines: readonly DealPipelineInfo[] }) => Promise<number>;

/** Чистая функция (rules.ts): сколько дней сделка лежит на этапе сверх `staleDays`; null — не залежалась. */
export type StaleDaysOf = (deal: { status: DealStatus; stageChangedAt: number }, stage: Pick<DealStageInfo, 'staleDays'> | undefined, now: number, tz?: string) => number | null;

/** Коды ошибок модуля (HTTP — дизайн §6). */
export const DEAL_DOMAIN_ERRORS = [
  'deal_closed',
  'deal_not_won',
  'outcome_required',
  'request_reused',
  'service_type_unknown',
  'amount_invalid',
  'won_at_invalid',
  'stage_unknown',
  'use_purchase',
  'use_lose',
  'next_step_required',
  'stage_fields_required',
  'stage_restricted',
  'reason_unknown',
  'reason_text_required',
  'service_type_locked',
  'invalid_settings',
] as const;
export type DealDomainErrorCode = (typeof DEAL_DOMAIN_ERRORS)[number];
