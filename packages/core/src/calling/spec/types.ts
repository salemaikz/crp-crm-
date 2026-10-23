// Исполняемая спецификация машины состояний карточки обзвона (PROCESS §3, §12).
// Здесь только типы и константы-данные. Реализация — чистая функция
// `applyOutcome(input: TransitionInput): TransitionResult` в
// `packages/core/src/calling/applyOutcome.ts` (K1d, builder). Тест-векторы — `vectors.ts`,
// порядок проверок и соглашения — `README.md` рядом.
//
// Правила ядра (AGENTS.md, D-011): без БД и Next, без `Date.now()` — время приходит
// параметром; пояс и календарь — объектом `WorkCalendar`; всё, что зависит от компании, —
// в `CallingSettings` (собирается из документа настроек, CONFIG.md §6.5–6.9, 6.12).

// ---------- Базовые типы ----------

/** Время, epoch-мс (UTC). */
export type Ms = number;
export type UserId = string;
/** Местные сутки установки, 'YYYY-MM-DD'. */
export type LocalDay = string;
/** Местное время 'HH:MM'. */
export type HHMM = string;

/** 9 состояний карточки [код] — PROCESS 3.1, `cards.state`. */
export const CARD_STATES = [
  'new',
  'retry',
  'callback',
  'agreed',
  'client',
  'not_interested',
  'not_target',
  'do_not_call',
  'written_off',
] as const;
export type CardState = (typeof CARD_STATES)[number];

/** 7 видов итога [код] — PROCESS 3.2, `calls.outcome_kind`. */
export const OUTCOME_KINDS = [
  'no_answer',
  'bad_number',
  'callback',
  'agreed',
  'not_interested',
  'not_target',
  'do_not_call',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** Рабочие состояния: в них возможны все 7 итогов (PROCESS 3.3). */
export const WORKING_STATES = ['new', 'retry', 'callback'] as const satisfies readonly CardState[];

/** Виды итога, которые считаются дозвоном (PROCESS 1, «Дозвон»). */
export const CONNECTED_KINDS = [
  'callback',
  'agreed',
  'not_interested',
  'not_target',
  'do_not_call',
] as const satisfies readonly OutcomeKind[];

/**
 * Из каких состояний итог применяется (PROCESS 3.5, № 4–12). Итог из другого
 * состояния — не ошибка, а факт: `fact_only` + `stale` (PROCESS 12.4, ред. K1d).
 */
export const OUTCOME_ALLOWED_FROM: Readonly<Record<OutcomeKind, readonly CardState[]>> = {
  no_answer: ['new', 'retry', 'callback'],
  bad_number: ['new', 'retry', 'callback'],
  callback: ['new', 'retry', 'callback'],
  agreed: ['new', 'retry', 'callback'],
  not_interested: ['new', 'retry', 'callback'],
  not_target: ['new', 'retry', 'callback', 'not_interested', 'agreed'],
  do_not_call: CARD_STATES,
};

/**
 * Виды, к которым применяется `calling.lprRequiredOnContact` (PROCESS 2.6, ред. K1d):
 * разговор состоялся с компанией по существу. Для «Не целевой» и «Полный отказ»
 * ЛПР обязателен только если это задано в `requires.lpr` самого итога.
 */
export const LPR_ON_CONTACT_KINDS = [
  'callback',
  'agreed',
  'not_interested',
] as const satisfies readonly OutcomeKind[];

/**
 * Источники задачи-проекции перезвона (D-050, PROCESS 3.5 ред. K1d). У карточки в
 * `callback` ровно одна открытая задача одного из этих источников; любой выход из
 * `callback` закрывает их все.
 */
export const CALLBACK_TASK_SOURCES = [
  'callback',
  'no_show',
  'rebook',
  'clarify_import',
] as const satisfies readonly TaskSource[];

/** Насколько время звонка с устройства может опережать приём (ARCHITECTURE §7). */
export const OCCURRED_FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Системные причины закрытия (не из справочника `reasons.*`). */
export type SystemCloseReason = 'no_answer_limit' | 'no_working_phone';

export type Lpr = '' | 'yes' | 'no';
export type Target = '' | 'yes' | 'no';
export type HoldReason = '' | 'dup_pair' | 'import_conflict' | 'no_working_phone' | 'rule';
export type FactReason = '' | 'owner_changed' | 'stale';
export type CallVia = 'ui' | 'offline' | 'import' | 'telephony' | 'manual_entry';
export type ReasonGroup = 'not_interested' | 'not_target' | 'do_not_call' | 'bad_number' | 'deal_lost' | 'callback' | 'written_off';

/** Точность срока перезвона: `time` — точное время, `day` — «в течение дня» (pipeline-v2 §4.2). */
export type CallbackPrecision = 'time' | 'day';

/** Какую причину система ставит сама (pipeline-v2 §4.1). */
export type ReasonSystem = 'no_show' | 'attended_no_purchase' | 'client_return' | 'return_due' | 'write_off';

/** Причина из `reasons.<группа>[]` в срезе, нужном ядру. */
export interface ReasonDef {
  code: string;
  /** Архивные принимаются (офлайн-итоги не теряются), но оператору не предлагаются. */
  archived: boolean;
  /** `false` — причину ставит только система; от человека — `reason_unknown`. */
  manual: boolean;
  system?: ReasonSystem;
  /** Для `system: 'no_show'` — ключи видов записи. */
  eventTypes?: string[];
}

// ---------- Карточка ----------

/** Телефон клиента глазами машины состояний (`client_phones` + стоп-лист). */
export interface PhoneSnapshot {
  id: string;
  kind: 'mobile' | 'landline' | 'unknown';
  isWorking: boolean;
  isPrimary: boolean;
  /** Номер есть в стоп-листе (по HMAC). */
  inStopList: boolean;
  /** Номер есть и у другого клиента (общий бухгалтер): в стоп-лист — только после подтверждения. */
  sharedWithOtherClient: boolean;
  /** Номер держит в стоп-листе другой клиент в `do_not_call`: при снятии запрета не удаляется. */
  heldByOtherDncClient: boolean;
}

/** Снимок карточки: колонки `cards` (ARCHITECTURE §4.3) в camelCase + телефоны клиента. */
export interface CardSnapshot {
  id: string;
  clientId: string;
  ownerUserId: UserId | null;
  actingUserId: UserId | null;
  actingUntilDay: LocalDay | '';
  state: CardState;
  holdReason: HoldReason;
  /** Недозвоны подряд. */
  attempts: number;
  nextCallAt: Ms | null;
  returnAt: Ms | null;
  lpr: Lpr;
  isTarget: Target;
  lastOutcomeCode: string;
  lastOutcomeKind: OutcomeKind | '';
  /** `occurred_at` последнего применённого итога. */
  lastOutcomeAt: Ms | null;
  closeReasonCode: string;
  closedAt: Ms | null;
  assignedAt: Ms | null;
  touchedInCrm: boolean;
  callsTotal: number;
  connectsTotal: number;
  noAnswerTotal: number;
  firstConnectAt: Ms | null;
  lastConnectAt: Ms | null;
  lastTouchAt: Ms | null;
  version: number;
  /** Причина текущего перезвона (ключ `reasons.callback`), '' — нет. */
  callbackReason: string;
  /** Касания цикла перезвона; сбрасывается вне `retry`/`callback`. */
  callbackTouches: number;
  /** Точность `nextCallAt`. */
  nextCallPrecision: CallbackPrecision;
  /** Порядок задаёт репозиторий: основной, затем мобильные, затем по времени добавления. */
  phones: PhoneSnapshot[];
}

// ---------- Контекст ----------

/**
 * Кто действует. Права «ресурс, действие» проверяет слой доступа до вызова
 * (`action()`, D-016); здесь нужен только охват, чтобы отличить владельца от чужого.
 */
export interface Actor {
  /** null — система (задачи воркера, приём, импорт). */
  userId: UserId | null;
  kind: 'user' | 'system';
  /** own — только свои карточки (владелец или временный владелец); space — всё пространство; relation — по отношению (дежурный, консультант). */
  scope: 'own' | 'space' | 'relation';
}

/** Рабочий календарь установки (пояс, рабочие дни, праздники, окно звонков). Реализация — `core/time` (P6). */
export interface WorkCalendar {
  /** Начало окна звонков, 'HH:MM' (`calendar.callWindow.start`). */
  readonly callWindowStart: HHMM;
  /** Местные сутки момента. */
  localDay(at: Ms): LocalDay;
  /** Рабочий ли день (рабочие дни недели минус праздники плюс рабочие переносы). */
  isWorkday(day: LocalDay): boolean;
  /** Момент в окне звонков рабочего дня. Окно полуоткрытое: начало входит, конец — нет. */
  isInCallWindow(at: Ms): boolean;
  /** `hhmm` первого рабочего дня строго после местных суток `at` (шаг `nextWorkday@HH:MM`). */
  nextWorkdayAt(at: Ms, hhmm: HHMM): Ms;
  /** Первый момент с местным временем `hhmm` в рабочий день, строго позже `after` («ближайший рабочий момент» для сдвига вне окна). */
  nextWorkdayTimeAfter(after: Ms, hhmm: HHMM): Ms;
  /** Плюс `days` календарных суток в местном поясе, то же местное время. */
  addDays(at: Ms, days: number): Ms;
}

/** Итог из справочника `calling.outcomes[]` (CONFIG §6.5). */
export interface OutcomeDef {
  key: string;
  kind: OutcomeKind;
  requires: {
    lpr: boolean;
    reason: boolean;
    callbackAt: boolean;
    /** Контакт «кто придёт». */
    contact: boolean;
    /** Запись или договорённость с датой. */
    agreement: boolean;
    // `requires.fields[]` (ниша и т. п.) проверяет движок полей K2 в C5, не машина состояний.
  };
  /** Группа причин итога (`outcomes[].reasonGroup`); нет — по виду итога. */
  reasonGroup?: string | null;
  archived: boolean;
  /** Время ревизии настроек, архивировавшей итог; архивный принимается ещё `offlineWindowHours` (PROCESS 12.31). */
  archivedAt: Ms | null;
}

export type AssignKind =
  | 'auto'
  | 'manual'
  | 'return'
  | 'absence'
  | 'release'
  | 'transfer'
  | 'inbound'
  | 'proposal'
  | 'merge';

/** Срез настроек, нужный машине состояний. Ключи — CONFIG.md. */
export interface CallingSettings {
  outcomes: OutcomeDef[];
  /** `calling.lprRequiredOnContact`. */
  lprRequiredOnContact: boolean;
  /** `calling.lprNoRequiresInfo`. */
  lprNoRequiresInfo: boolean;
  /** `calling.callbackPastToleranceMin`. */
  callbackPastToleranceMin: number;
  /** `calling.offlineWindowHours`. */
  offlineWindowHours: number;
  /** `calling.retry.steps` (`+Nh`, `+Nm`, `nextWorkday@HH:MM`), `calling.retry.maxAttempts`. */
  retry: { steps: string[]; maxAttempts: number };
  /** `calling.returnDays`; null — не возвращать. */
  returnDays: { not_interested: number | null; deal_lost_soft: number | null };
  /** `queue.skipLimit`. */
  skipLimit: number;
  /** `distribution.capIncludes`. */
  capIncludes: AssignKind[];
  /** `booking.noShow.callbackAt` (шаг). */
  noShowCallbackAt: string;
  /** `booking.nextStep.taskAt` (шаг). */
  nextStepTaskAt: string;
  /** `booking.attendance.autoNoShowWorkdays`; null — автонеявка выключена. */
  autoNoShowWorkdays: number | null;
  /** `tasks.inboundReplyMinutes`. */
  inboundReplyMinutes: number;
  /** `reasons.*`; нет ключа — проверка принадлежности группе не выполняется (настройки до воронки v2). */
  reasons?: Partial<Record<ReasonGroup, ReasonDef[]>>;
  /** `calling.callbackReason`. */
  callbackReason?: { required: boolean };
  /** `calling.callbackSchedule.steps` (`+Nd`, `+Nd@HH:MM`). */
  callbackSchedule?: { steps: string[] };
}

// ---------- События (вход) ----------

/** Что отдаёт слой БД о прежнем итоге с тем же opId (`calls.id`). */
export interface PriorCall {
  applied: 'applied' | 'fact_only';
  factReason: FactReason;
}

/** Итог звонка (PROCESS 3.5 № 4–12, 26; 12.1–12.9, 12.31). */
export interface OutcomeEvent {
  type: 'outcome';
  /** ID итога, созданный на устройстве (D-019). */
  opId: string;
  outcomeKey: string;
  via: 'ui' | 'offline' | 'manual_entry' | 'telephony';
  /** Время звонка по устройству. */
  occurredAt: Ms;
  /** Время приёма сервером. */
  receivedAt: Ms;
  /** Номер разговора. Обязателен для `bad_number`. */
  phoneId: string | null;
  reasonCode: string;
  /** Есть непустая заметка (сам текст машине не нужен). */
  hasNote: boolean;
  lpr: Lpr;
  /** Заполнено хотя бы одно поле ЛПР: имя, прямой номер, «когда звонить». */
  lprInfoFilled: boolean;
  callbackAt: Ms | null;
  /**
   * Точность срока. Есть — новый контракт (воронка v2): причина по `reasons.callback`, касание считается.
   * Нет — старое устройство: причина необязательна и не пишется, точность `time` (§4.4).
   */
  callbackPrecision?: CallbackPrecision;
  /** Чип «Целевой: да». */
  markTarget: boolean;
  /** Номера, отмеченные «тоже не звонить» (только `do_not_call`). */
  alsoDncPhoneIds: string[];
  agreement: {
    contactId: string | null;
    bookingId: string | null;
    /** Договорённость с датой без записи. */
    agreedDueAt: Ms | null;
  } | null;
  /** Версия, которую видел оператор. Для итога не сравнивается (PROCESS 3.5, 12.4). */
  seenVersion: number | null;
  facts: {
    /** Строка `calls` с тем же opId уже есть. */
    sameOpId: PriorCall | null;
    /** Действующий был владельцем или временным владельцем в момент звонка (по `assign_log`). */
    actorWasOwnerAtCall: boolean;
  };
}

interface EventBase {
  /** ID запроса (идемпотентность, `source_key` задач). */
  opId: string;
}

interface ManualBase extends EventBase {
  /** Ручное действие проходит, только если версия совпала (PROCESS 3.5, 12.1). */
  seenVersion: number;
}

/** № 1. */
export interface EnterEvent extends EventBase {
  type: 'enter';
  cardId: string;
  clientId: string;
  phones: PhoneSnapshot[];
  sourceKey: string;
  holdReason: HoldReason;
}

/** № 2. Лимит, календарь, пауза и пары проверяет ядро раздачи до вызова; здесь — остаток лимита. */
export interface AssignEvent extends EventBase {
  type: 'assign';
  mode: 'auto' | 'manual';
  toUserId: UserId;
  /** Прогон тика; одно сводное уведомление на прогон. */
  runId: string | null;
  seenVersion: number | null;
  facts: { capRemaining: number };
}

/** № 3; № 23 для нетронутых новых. */
export interface ReleaseEvent extends EventBase {
  type: 'release';
  seenVersion: number | null;
}

/**
 * № 11, № 12 из меню карточки, без звонка (PROCESS 3.2, последний абзац); № 32 — ручное списание
 * (`written_off`, только из `new`/`retry`/`callback`, причина из `reasons.written_off`).
 */
export interface CloseFromMenuEvent extends ManualBase {
  type: 'close_from_menu';
  kind: 'not_target' | 'do_not_call' | 'written_off';
  reasonCode: string;
  alsoDncPhoneIds: string[];
}

/** № 13, 12.23, 12.24. */
export interface ReturnDueEvent extends EventBase {
  type: 'return_due';
  runId: string;
  facts: { ownerActive: boolean; capRemaining: number };
}

/** № 14. */
export interface ReopenEvent extends ManualBase {
  type: 'reopen';
  comment: string;
}

/** № 15. */
export interface DncClearEvent extends ManualBase {
  type: 'dnc_clear';
  comment: string;
}

/** № 16. */
export interface NoShowEvent extends EventBase {
  type: 'no_show';
  bookingId: string;
  /** Ключ вида записи (для причины `no_show_<вид>`); нет — причина пустая. */
  eventType?: string;
  facts: { hasOtherFutureBooking: boolean };
}

/** № 28: `attendance-sweep` в 10:00 рабочего дня. */
export interface AttendanceSweepEvent extends EventBase {
  type: 'attendance_sweep';
  bookingId: string;
  /** Дежурный (групповое) или консультант (консультация). */
  markerUserId: UserId;
  /** Ключ вида записи (для причины неявки). */
  eventType?: string;
  facts: { workdaysElapsed: number; hasOtherFutureBooking: boolean };
}

/** № 17, 12.7. */
export interface BookingCancelledEvent extends EventBase {
  type: 'booking_cancelled';
  bookingId: string;
  reason: 'client' | 'operator_error';
  /** opId итога «Договорились», создавшего сделку (для 12.7). */
  createdByOpId: string | null;
  facts: { hasOtherFutureBooking: boolean };
}

/** № 18. */
export interface AttendedEvent extends EventBase {
  type: 'attended';
  bookingId: string;
  eventDay: LocalDay;
  facts: { hasNextFutureBooking: boolean };
}

/** № 19. */
export interface PurchaseEvent extends EventBase {
  type: 'purchase';
  dealId: string | null;
  serviceTypeKey: string;
  amountKzt: number;
}

/** № 20. */
export interface PurchaseCancelledEvent extends EventBase {
  type: 'purchase_cancelled';
  dealId: string;
  comment: string;
  facts: { hasOtherOpenDeal: boolean };
}

/** № 21. */
export interface DealLostEvent extends EventBase {
  type: 'deal_lost';
  dealId: string;
  reasonCode: string;
  /** `reasons.deal_lost[].softness`. */
  softness: 'soft' | 'hard';
  facts: { hasOtherOpenDeal: boolean };
}

/** № 22. */
export interface TransferEvent extends ManualBase {
  type: 'transfer';
  toUserId: UserId;
  facts: { toUserActive: boolean };
}

/** № 23. Какие карточки попадают под отсутствие, решает ядро раздачи. */
export interface AbsenceEvent extends EventBase {
  type: 'absence';
  actingUserId: UserId;
  untilDay: LocalDay;
}

/** № 24, 12.20, 12.21. `card` во входе — остающаяся карточка. */
export interface MergeEvent extends ManualBase {
  type: 'merge';
  other: CardSnapshot;
  /** Чей владелец остаётся: auto — у карточки с более поздним итогом. */
  ownerFrom: 'auto' | 'survivor' | 'other';
}

/** № 25. */
export interface SkipEvent extends EventBase {
  type: 'skip';
  facts: { skipsToday: number };
}

/** № 27, системная часть: пришло сообщение или пропущенный звонок. */
export interface InboundMessageEvent extends EventBase {
  type: 'inbound_message';
  channel: 'messenger' | 'call';
}

/** № 27, кнопка «Вернуть в работу» на задаче «Ответить». */
export interface InboundReactivateEvent extends ManualBase {
  type: 'inbound_reactivate';
}

/** № 29: ночная сверка инварианта D-049. */
export interface AgreedSweepEvent extends EventBase {
  type: 'agreed_sweep';
  facts: { hasFutureBooking: boolean; hasOpenOwnerTask: boolean };
}

/** № 30, 12.39: импорт итога вида `agreed` («Подтвержден»). */
export interface ImportAgreedEvent extends EventBase {
  type: 'import_agreed';
  outcomeKey: string;
  /** Дата снимка таблицы. */
  occurredAt: Ms;
  bookingId: string | null;
}

/** № 31. */
export interface AttendanceCorrectedEvent extends EventBase {
  type: 'attendance_corrected';
  bookingId: string;
  /** Когда была отметка «Не пришёл» (ручная или автонеявка). */
  noShowMarkedAt: Ms;
  /**
   * Есть открытая задача `no_show:<bookingId>` этой записи (pipeline-v2 §3.3, № 31). `false` — `stale`;
   * нет ключа — проверка не выполняется (сервер до воронки v2).
   */
  facts: { hasNextFutureBooking: boolean; hasOpenNoShowTask?: boolean };
}

/**
 * № 33: выход из «Договорились» без звонка (pipeline-v2 §3.3). Явку по записи открытой сделки сервер уже отметил
 * в той же транзакции через порт записи, без события карточки; ядро получает только факт.
 */
export interface AgreedExitEvent extends ManualBase {
  type: 'agreed_exit';
  to: 'callback' | 'not_interested' | 'written_off';
  reasonCode: string;
  /** Только для `callback`. */
  callbackAt: Ms | null;
  callbackPrecision?: CallbackPrecision;
  /** Явка, отмеченная этим же действием; `changed: false` — запись уже была в этом статусе. */
  attendance: { bookingId: string; to: 'attended' | 'no_show'; eventKind: 'group' | 'individual'; changed: boolean } | null;
  /** Будущие активные записи клиента (для «нужна перезапись» при отмене без явки). */
  facts: { futureBookingIds: string[] };
}

export type CardEvent =
  | OutcomeEvent
  | EnterEvent
  | AssignEvent
  | ReleaseEvent
  | CloseFromMenuEvent
  | ReturnDueEvent
  | ReopenEvent
  | DncClearEvent
  | NoShowEvent
  | AttendanceSweepEvent
  | BookingCancelledEvent
  | AttendedEvent
  | PurchaseEvent
  | PurchaseCancelledEvent
  | DealLostEvent
  | TransferEvent
  | AbsenceEvent
  | MergeEvent
  | SkipEvent
  | InboundMessageEvent
  | InboundReactivateEvent
  | AgreedSweepEvent
  | ImportAgreedEvent
  | AttendanceCorrectedEvent
  | AgreedExitEvent;

export interface TransitionInput {
  /** null только для `enter`. */
  card: CardSnapshot | null;
  event: CardEvent;
  actor: Actor;
  /** «Сейчас» сервера. */
  now: Ms;
  settings: CallingSettings;
  calendar: WorkCalendar;
}

// ---------- Побочные эффекты (выход) ----------

/** `tasks.source` (ARCHITECTURE §4.3). */
export type TaskSource =
  | 'manual'
  | 'callback'
  | 'no_show'
  | 'rebook'
  | 'inbound_message'
  | 'missed_call'
  | 'handoff'
  | 'grey_unassigned'
  | 'dnc_inbound'
  | 'review'
  | 'proposal'
  | 'attendance_mark'
  | 'next_step'
  | 'agreement'
  | 'clarify_import'
  | 'absent_review';
export type TaskKind = 'call' | 'message' | 'meeting' | 'handoff' | 'check' | 'other';

/** Получатель: конкретный сотрудник или все с охватом space по задачам (руководитель отдела). */
export type Recipient = { user: UserId } | { role: 'lead' };

export type TaskEffect =
  | {
      op: 'create';
      source: TaskSource;
      kind: TaskKind;
      assignee: Recipient;
      dueAt: Ms | null;
      /** `tasks.source_key`: автозадача не задваивается. */
      sourceKey: string;
      /** `tasks.due_precision`; пишется только для `day`, иначе поля нет. */
      duePrecision?: CallbackPrecision;
    }
  /** Закрыть открытые задачи клиента в пространстве: по источникам или все. */
  | { op: 'close'; sources: TaskSource[] | 'all' }
  | { op: 'close_by_key'; sourceKey: string }
  | { op: 'reassign_open'; to: UserId };

/** Намерения для модуля сделок (стадии — по `stages[].auto`, CONFIG §6.8). */
export type DealEffect =
  /** Создать сделку на этапе `auto = on_agreed` или взять существующую открытую. */
  | { op: 'ensure_open'; stage: 'on_agreed'; requestId: string }
  /** Только вперёд. */
  | { op: 'advance'; stage: 'on_attended'; bookingId: string }
  | { op: 'set_needs_rebook'; bookingId: string; value: boolean }
  /** Все открытые сделки клиента → проигран. */
  | { op: 'lose_open'; reasonGroup: ReasonGroup; reasonCode: string }
  | { op: 'lose'; dealId: string; reasonGroup: ReasonGroup; reasonCode: string }
  /** 12.7: сделку, созданную итогом opId, закрыть системной причиной «ошибка ввода». */
  | { op: 'lose_created_by'; opId: string; reasonCode: 'input_error' }
  /** Покупка; передачу в отдел по `serviceTypes[].team` создаёт модуль сделок. */
  | { op: 'win'; dealId: string | null; serviceTypeKey: string; amountKzt: number; requestId: string }
  | { op: 'cancel_purchase'; dealId: string }
  | { op: 'reassign_open'; to: UserId };

export type BookingEffect =
  | { op: 'cancel_future'; reason: 'not_target' | 'do_not_call' | 'client' }
  | { op: 'reassign_future'; to: UserId };

export type StopListEffect =
  | { op: 'add'; phoneId: string; reasonCode: string }
  | { op: 'remove'; phoneId: string };

export interface AssignLogEffect {
  kind: AssignKind;
  fromUserId: UserId | null;
  toUserId: UserId | null;
  countsToCap: boolean;
}

export type NotificationKind =
  | 'cards_assigned'
  | 'card_returned'
  | 'card_reopened'
  | 'no_show'
  | 'client_transferred'
  | 'card_merged';

export interface NotificationEffect {
  kind: NotificationKind;
  to: Recipient;
  /** `notifications.dedupe_key`: одно сводное на прогон. */
  dedupeKey: string | null;
}

export type TimelineKind =
  | 'card.created'
  | 'card.assigned'
  | 'card.released'
  | 'card.transferred'
  | 'card.acting'
  | 'card.merged'
  | 'card.state'
  | 'call'
  | 'phone.not_working'
  | 'phone.primary'
  | 'dnc.set'
  | 'dnc.cleared';

/** Повод смены состояния без звонка (`data.cause` события `card.state`). */
export type StateCause =
  | 'menu_close'
  | 'return_due'
  | 'reopen'
  | 'dnc_clear'
  | 'no_show'
  | 'booking_cancelled'
  | 'purchase'
  | 'purchase_cancelled'
  | 'deal_lost'
  | 'inbound_reactivate'
  | 'attendance_corrected'
  | 'agreed_exit';

/** Событие ленты `client_events`: только коды, id и числа, без ПДн (D-020). */
export interface TimelineEffect {
  kind: TimelineKind;
  at: Ms;
  actorId: UserId | null;
  ref: { type: 'call' | 'card_move'; id: string } | null;
  data: Record<string, string | number | boolean | null>;
}

export interface AuditEffect {
  kind: 'dnc.cleared' | 'card.merged';
  data: Record<string, string | number | boolean | null>;
}

export interface SkipEffect {
  opId: string;
  day: LocalDay;
}

/** Все массивы присутствуют всегда (пустые, если эффектов нет): векторы сравниваются глубоко. */
export interface Effects {
  tasks: TaskEffect[];
  deals: DealEffect[];
  bookings: BookingEffect[];
  stopList: StopListEffect[];
  assignLog: AssignLogEffect[];
  notifications: NotificationEffect[];
  timeline: TimelineEffect[];
  audit: AuditEffect[];
  skips: SkipEffect[];
}

/** Строка `calls` (ARCHITECTURE §4.3), которую пишет слой БД. */
export interface CallRecord {
  id: string;
  outcomeCode: string;
  outcomeKind: OutcomeKind;
  reasonCode: string;
  lpr: Lpr;
  callbackAt: Ms | null;
  /** `calls.callback_precision`. */
  callbackPrecision: CallbackPrecision;
  phoneId: string | null;
  via: CallVia;
  applied: 'applied' | 'fact_only';
  factReason: FactReason;
  /** После ограничения окном [приём − offlineWindowHours, приём + 5 мин]. */
  occurredAt: Ms;
  receivedAt: Ms;
  userId: UserId | null;
  ownerUserIdAtCall: UserId | null;
}

export type Warning = 'callback_outside_work_hours' | 'occurred_at_clamped';

export type RejectCode =
  | 'not_found'
  | 'forbidden'
  | 'version_conflict'
  | 'invalid_transition'
  | 'cap_exhausted'
  | 'skip_limit'
  | 'outcome_unknown'
  | 'outcome_archived'
  | 'reason_required'
  | 'reason_unknown'
  | 'lpr_required'
  | 'lpr_info_required'
  | 'callback_at_required'
  | 'callback_in_past'
  | 'contact_required'
  | 'agreement_required'
  | 'phone_required'
  | 'comment_required'
  | 'amount_invalid'
  | 'service_type_required'
  | 'user_inactive'
  | 'too_early'
  | 'stale'
  | 'touched_in_crm'
  /** № 32: оператор списывает карточку, у которой не было недозвона. */
  | 'write_off_needs_no_answer';

// ---------- Результат ----------

export interface AppliedResult {
  status: 'applied';
  /** Новое состояние карточки. `version + 1`, только если изменилось хоть одно поле. */
  card: CardSnapshot;
  call: CallRecord | null;
  effects: Effects;
  warnings: Warning[];
}

/** Звонок записан фактом, состояние не меняется (PROCESS 12.1, 12.4, 12.5). */
export interface FactOnlyResult {
  status: 'fact_only';
  factReason: 'owner_changed' | 'stale';
  /** Меняются только счётчики звонков, `touchedInCrm` и `version`. */
  card: CardSnapshot;
  call: CallRecord;
  effects: Effects;
  warnings: Warning[];
}

/** Повтор opId: ничего не меняется, возвращается результат первого раза (PROCESS 12.2). */
export interface DuplicateResult {
  status: 'duplicate';
  applied: 'applied' | 'fact_only';
  factReason: FactReason;
}

export interface RejectedResult {
  status: 'rejected';
  error: RejectCode;
  /** Поле события, к которому относится ошибка проверки, иначе null. */
  field: string | null;
}

export type TransitionResult = AppliedResult | FactOnlyResult | DuplicateResult | RejectedResult;

/** Сигнатура реализации (K1d). */
export type ApplyOutcome = (input: TransitionInput) => TransitionResult;

// ---------- Вектор ----------

export interface TransitionVector {
  /** Уникальный id: `r<№ строки 3.5><буква>` или `e<№ случая 12>…`. */
  id: string;
  /** Ссылки на PROCESS.md: «3.5 №4», «12.3», «3.4». */
  refs: string[];
  /** Что проверяем, по-русски. */
  title: string;
  input: TransitionInput;
  expected: TransitionResult;
}
