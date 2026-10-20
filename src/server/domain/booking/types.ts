// Запись на групповые мероприятия: контракт домена (B2). Дизайн — docs/booking-design.md, решения D-131…D-137.
// Здесь только типы и сигнатуры; тела пишет builder в settings.ts, repo.ts, series.ts, events.ts,
// bookings.ts, effects.ts, deps.ts. Сигнатуры меняются только через architect.
//
// Правила модуля:
// - SQL — только в repo.ts; первый аргумент функции репозитория — actor (Viewer или SystemActor);
// - строки клиентов, карточек и записей — только через scopeSql; места мероприятия («осталось N из M») —
//   агрегат без охвата записей (D-136);
// - порядок блокировок: карточка → мероприятие → записи (D-131);
// - карточку меняет только машина состояний обзвона через CardPort (D-133), сделку — DealLink (D-134).
import type { booking as core, calling, time } from '@crm/core';
import type { SystemActor, Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export type BookingActor = Viewer | SystemActor;

// ---------------------------------------------------------------------------
// Настройки (CONFIG §6.9, §6.8, календарь §6.1–6.2) — срез пространства
// ---------------------------------------------------------------------------

/** Формат мероприятия; '' — старые данные без формата. Закрытый список проверяет Zod, не БД. */
export const EVENT_FORMATS = ['offline', 'online'] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];

/** Групповой вид из `booking.eventTypes[]` (behavior = group). */
export interface GroupEventType {
  key: string;
  capacity: number;
  durationMin: number;
}

/** Стартовая серия из `booking.seedSeries[]`: умолчания места и формата для разовых мероприятий. */
export interface SeedSeries {
  key: string;
  eventTypeKey: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string;
  format: EventFormat;
  capacity: number;
}

/** Этапы сделки, которые трогает запись (CONFIG §6.8: `createDealOn`, `stages[].auto`). */
export interface DealStages {
  pipelineKey: string;
  /** Этап `auto = on_agreed`; null — воронка не создаёт сделку при записи (`createDealOn` не `agreed`). */
  onAgreedStageKey: string | null;
  /** Этап `auto = on_attended`; null — явка этап не двигает. */
  onAttendedStageKey: string | null;
}

export interface BookingSettings {
  spaceId: string;
  timeZone: string;
  calendar: time.WorkCalendar;
  groupTypes: readonly GroupEventType[];
  /** `booking.horizonDays`. */
  horizonDays: number;
  /** `booking.groupOptions`: сколько ближайших мероприятий предлагает мастер. */
  groupOptions: number;
  seedSeries: readonly SeedSeries[];
  /** null — в пространстве нет воронки продаж с `createDealOn: agreed`. */
  deals: DealStages | null;
  /** Окно отмены «ошибка оператора» автором (PROCESS 12.7), минуты. Константа продукта: 10. */
  operatorErrorWindowMin: number;
  /** B3a: виды, направления и консультации без графиков (мастер записи, «серая» заявка на консультацию). */
  catalog: BookingCatalog;
}

export type LoadBookingSettings = (spaceId: string, now: number) => Promise<BookingSettings>;

// ---------------------------------------------------------------------------
// Проекции для интерфейса и API (без `custom` и других полей с ПДн, кроме списка гостей)
// ---------------------------------------------------------------------------

export interface EventView {
  id: string;
  seriesId: string | null;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  location: string;
  format: EventFormat | '';
  capacity: number;
  status: core.EventStatus;
  touched: boolean;
  seats: core.Seats;
  /** Токен оптимистичной правки (у events нет version). */
  updatedAt: number;
}

export interface BookingView {
  id: string;
  kind: core.EventBehavior;
  eventTypeKey: string;
  eventId: string | null;
  resourceId: string | null;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  bookingDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  directionKey: string;
  isReserve: boolean;
  status: core.BookingStatus;
  cancelReason: BookingCancelReason;
  via: BookingVia;
  /** Заслуга (PROCESS 5.6): не меняется ни переносом, ни передачей клиента. */
  bookedByUserId: string | null;
  /** Ответственный: владелец карточки; меняет передача клиента. */
  responsibleUserId: string | null;
  movedFromId: string | null;
  movedToId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** `bookings.cancel_reason`. `not_target` — после миграции M1 (docs/booking-design.md §12). */
export type BookingCancelReason = core.CancelReason | 'not_target';
export type BookingVia = 'ui' | 'import' | 'walk_in';

/** Вариант мастера записи: мероприятие с местами. */
export type EventOption = Pick<EventView, 'id' | 'eventTypeKey' | 'eventDate' | 'startTime' | 'startsAt' | 'durationMin' | 'location' | 'format' | 'seats'>;

export interface OfferResult {
  options: EventOption[];
  /** Активная будущая запись клиента того же вида: новая запись станет переносом (D-042). */
  current: BookingView | null;
}

/** Строка списка гостей (PROCESS 5.5, D-072): минимум ПДн, номер — только последние 4 цифры. */
export interface GuestRow {
  bookingId: string;
  status: core.BookingStatus;
  version: number;
  clientName: string;
  contactName: string;
  phoneTail: string;
  bookedByName: string;
  via: BookingVia;
}

export interface SeriesView {
  id: string;
  eventTypeKey: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string;
  format: EventFormat | '';
  capacity: number;
  active: boolean;
  updatedAt: number;
  /** Даты горизонта, пропущенные календарём (праздники): РОП может создать разовое мероприятие. */
  skipped: core.SkippedOccurrence[];
}

export interface SyncReport {
  seriesId: string;
  created: number;
  updated: number;
  /** Нетронутые мероприятия, снятые синхронизацией (status cancelled, occurrence_key NULL; D-135). */
  retired: number;
  skipped: core.SkippedOccurrence[];
}

// ---------------------------------------------------------------------------
// Ошибки домена (HTTP — docs/booking-design.md §10)
// ---------------------------------------------------------------------------

export const BOOKING_DOMAIN_ERRORS = [
  'outcome_required',
  'request_reused',
  'event_has_bookings',
  'capacity_below_taken',
  'card_port_unavailable',
] as const;
export type BookingDomainErrorCode = core.BookingErrorCode | (typeof BOOKING_DOMAIN_ERRORS)[number];

/** Что несёт ошибка домена (класс — errors.ts). `alternatives` — только у `event_full`. */
export interface BookingFailure {
  code: BookingDomainErrorCode;
  alternatives?: EventOption[];
}

// ---------------------------------------------------------------------------
// Порты: карточка обзвона (реализует calling в C5) и сделка (deals, этот поток)
// ---------------------------------------------------------------------------

/** Карточка, заблокированная `SELECT … FOR UPDATE` в транзакции записи. */
export interface LockedCard {
  id: string;
  clientId: string;
  spaceId: string;
  state: calling.CardState;
  ownerUserId: string | null;
  actingUserId: string | null;
  lastOutcomeAt: number | null;
  version: number;
}

/** События записи для машины состояний карточки (PROCESS 3.5 № 16–18, 28, 31). */
export type BookingCardEvent =
  | calling.NoShowEvent
  | calling.AttendedEvent
  | calling.BookingCancelledEvent
  | calling.AttendanceCorrectedEvent
  | calling.AttendanceSweepEvent;

/**
 * Применить событие записи к карточке в транзакции `tx`: снимок → `calling.applyOutcome` → запись карточки
 * и эффектов (задачи через tasks/auto.ts, лента, уведомления, сделки через deals/effects.ts, записи через
 * booking/effects.ts). Карточка уже заблокирована вызывающим. `rejected` не бросает: решает вызывающий.
 *
 * Контракт `actor`: порт охват не проверяет (его проверил вызывающий) и берёт сотрудника как есть. Каскад, где
 * охват сотрудника на карточку не распространяется (отмена мероприятия: гости могут быть вне команды отменяющего),
 * обязан передать `opts.system = true`: порт выполняет событие от системы (в ленте и журналах сотрудника нет),
 * а не с охватом `actor`. Действие сотрудника над своей записью (запись, явка, отмена) идёт без флага.
 */
export interface CardPortOptions {
  /** Каскад: выполнить событие от системы, не от сотрудника `actor`. */
  system?: boolean;
}

export interface CardPort {
  applyBookingEvent(tx: Sql, actor: BookingActor, card: LockedCard, event: BookingCardEvent, now: number, opts?: CardPortOptions): Promise<calling.TransitionResult>;
}

/** Что запись делает со сделкой напрямую (без события карточки). Реализация — deals/effects.ts. */
export interface DealLink {
  /** Открытая сделка клиента в воронке или новая на этапе `onAgreedStageKey`; null — сделку не создаём. Идемпотентно. */
  ensureOpen(tx: Sql, actor: BookingActor, card: LockedCard, args: { requestId: string; at: number; stages: DealStages | null }): Promise<string | null>;
  /** Только вперёд (PROCESS 4.2). */
  advanceOnAttended(tx: Sql, actor: BookingActor, args: { dealId: string; bookingId: string; at: number; stages: DealStages | null }): Promise<void>;
}

export interface BookingDeps {
  cards: CardPort;
  deals: DealLink;
  settings: LoadBookingSettings;
  now: () => number;
}

/** Внутри чужой транзакции (C5: итог «Договорились»): без своей транзакции и без повтора. */
export interface TxOptions {
  tx?: Sql;
}

// ---------------------------------------------------------------------------
// Записи
// ---------------------------------------------------------------------------

export interface GroupBookingRequest {
  kind: 'group';
  /** Ключ запроса из мастера (UUID): повтор возвращает прежний результат (D-132). */
  requestId: string;
  clientId: string;
  eventId: string;
  /** Контакт «кто придёт»; должен принадлежать клиенту. */
  contactId: string | null;
}

/** Консультация и «серая» заявка (resourceId = null) — реализует B3a/B5; модель B2 их допускает. */
export interface IndividualBookingRequest {
  kind: 'individual';
  requestId: string;
  clientId: string;
  eventTypeKey: string;
  date: string;
  time: string;
  directionKey: string;
  resourceId: string | null;
  contactId: string | null;
}

export type CreateBookingRequest = GroupBookingRequest | IndividualBookingRequest;

export interface CreateBookingOptions extends TxOptions {
  /** C5: запись внутри итога «Договорились» — карточку уже заблокировал вызывающий, её состояние не проверяется. */
  fromOutcome?: { opId: string };
  /** C4b (импорт «Записи»): источник и автор из таблицы; null — автор неизвестен. */
  imported?: { importKey: string; bookedByUserId: string | null };
}

export type CreateBookingResult =
  | { action: 'created'; booking: BookingView; replayed: boolean }
  | { action: 'moved'; booking: BookingView; movedFromId: string; replayed: boolean };

/** Ручные действия со статусом: `opId` = id строки booking_history (идемпотентность), `version` записи. */
export interface BookingActionBase {
  bookingId: string;
  opId: string;
  version: number;
}

export type ConfirmInput = BookingActionBase & { to: 'confirmed' | 'registered' };
export type AttendanceInput = BookingActionBase & { to: 'attended' | 'no_show' };
export type CancelInput = BookingActionBase & { reason: 'client' | 'operator_error' };
export interface MoveInput {
  bookingId: string;
  version: number;
  /** Ключ новой записи. */
  requestId: string;
  eventId: string;
}

export interface BookingListFilter {
  from: string;
  to: string;
  status?: readonly core.BookingStatus[];
  eventId?: string;
  clientId?: string;
  limit?: number;
}

export type CreateBooking = (deps: BookingDeps, actor: BookingActor, req: CreateBookingRequest, opts?: CreateBookingOptions) => Promise<CreateBookingResult>;
export type MoveBooking = (deps: BookingDeps, viewer: Viewer, input: MoveInput) => Promise<CreateBookingResult>;
export type SetConfirmation = (deps: BookingDeps, viewer: Viewer, input: ConfirmInput) => Promise<BookingView>;
export type MarkAttendance = (deps: BookingDeps, viewer: Viewer, input: AttendanceInput) => Promise<BookingView>;
export type CancelBooking = (deps: BookingDeps, viewer: Viewer, input: CancelInput) => Promise<BookingView>;
export type GetBooking = (viewer: Viewer, bookingId: string) => Promise<BookingView>;
export type ListBookings = (viewer: Viewer, filter: BookingListFilter) => Promise<BookingView[]>;

/** B4b (`attendance-sweep`): только интерфейс в B2. `reminded` — задачи «Отметьте явку», `marked` — «Не пришёл». */
export type SweepAttendance = (deps: BookingDeps, actor: SystemActor, input: { bookingId: string; opId: string }) => Promise<'marked' | 'reminded' | 'skipped'>;

/** Эффекты `calling.BookingEffect` для исполнителя эффектов карточки (C5, C6b, B9a). Без событий карточки. */
export type ApplyBookingEffects = (
  tx: Sql,
  actor: BookingActor,
  card: Pick<LockedCard, 'id' | 'clientId' | 'spaceId'>,
  effects: readonly calling.BookingEffect[],
  at: number,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Мероприятия и серии
// ---------------------------------------------------------------------------

export interface EventListFilter {
  from: string;
  to: string;
  eventTypeKey?: string;
  includeCancelled?: boolean;
}

export interface EventInput {
  /** id нового мероприятия = ключ запроса (UUID): повтор не создаёт второе (D-132). */
  requestId: string;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  /** Не задано — из вида мероприятия. */
  durationMin?: number;
  capacity?: number;
  /** Не задано — из активной серии вида, затем из `seedSeries`. */
  location?: string;
  format?: EventFormat;
}

/** Дата и время меняются только у мероприятия без записей (D-137). */
export type EventPatch = Partial<Pick<EventInput, 'eventDate' | 'startTime' | 'durationMin' | 'capacity' | 'location' | 'format'>>;

export interface SeriesInput {
  eventTypeKey: string;
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string;
  format: EventFormat;
  capacity: number;
}

export interface CancelEventResult {
  event: EventView;
  cancelledBookings: number;
  replayed: boolean;
}

export type OfferEvents = (deps: BookingDeps, viewer: Viewer, input: { clientId: string; eventTypeKey?: string }) => Promise<OfferResult>;
export type ListEvents = (deps: BookingDeps, viewer: Viewer, filter: EventListFilter) => Promise<EventView[]>;
export type GetEvent = (viewer: Viewer, eventId: string) => Promise<EventView>;
export type CreateEvent = (deps: BookingDeps, viewer: Viewer, input: EventInput) => Promise<EventView>;
export type UpdateEvent = (deps: BookingDeps, viewer: Viewer, input: { eventId: string; seenUpdatedAt: number; patch: EventPatch }) => Promise<EventView>;
export type CancelEvent = (deps: BookingDeps, viewer: Viewer, input: { eventId: string; opId: string }) => Promise<CancelEventResult>;
export type SetEventDuty = (deps: BookingDeps, viewer: Viewer, input: { eventId: string; userIds: readonly string[] }) => Promise<{ userIds: string[] }>;
export type ListGuests = (deps: BookingDeps, viewer: Viewer, eventId: string) => Promise<GuestRow[]>;

export type ListSeries = (deps: BookingDeps, viewer: Viewer) => Promise<SeriesView[]>;
export type CreateSeries = (deps: BookingDeps, viewer: Viewer, input: SeriesInput & { requestId: string }) => Promise<{ series: SeriesView; sync: SyncReport }>;
export type UpdateSeries = (
  deps: BookingDeps,
  viewer: Viewer,
  input: { seriesId: string; seenUpdatedAt: number; patch: Partial<SeriesInput> & { active?: boolean } },
) => Promise<{ series: SeriesView; sync: SyncReport }>;
/** Синхронизация одной серии по `core.planSeriesSync` (в запросе РОП и в job `events-ensure`). */
export type SyncSeries = (deps: BookingDeps, actor: BookingActor, seriesId: string, opts?: TxOptions) => Promise<SyncReport>;
/** Job `events-ensure` (регистрирует P7): все активные серии всех пространств. */
export type EnsureAllSeries = (deps: BookingDeps, actor: SystemActor) => Promise<SyncReport[]>;

// ---------------------------------------------------------------------------
// B3a: мастер записи и минимальная заявка на консультацию («серая», без консультанта).
// Дизайн — docs/booking-wizard-design.md, решения D-201…D-205. Только новые типы и сигнатуры;
// единственная разрешённая правка существующего — поле `catalog` в BookingSettings (§3 дизайна, D-203).
// ---------------------------------------------------------------------------

/** Подпись из настроек (`I18n` ядра настроек): `ru` обязательна, `kk` — казахский слой. */
export interface LocalizedLabel {
  ru: string;
  kk?: string;
}

/** Вид мероприятия из `booking.eventTypes[]` в порядке настроек — вкладки мастера. */
export interface EventTypeInfo {
  key: string;
  behavior: core.EventBehavior;
  label: LocalizedLabel;
  short: LocalizedLabel;
  durationMin: number;
  /** Ключи `booking.directions[]`, разрешённые виду; пусто — все. */
  directions: readonly string[];
}

/** Срез `booking.*` для консультаций без графиков (CONFIG §6.9). */
export interface ConsultSettings {
  /** `booking.consult.slotMinutes`: шаг сетки времени заявки. */
  slotMinutes: number;
  /** `booking.consult.hours`: рабочие дни и часы консультантов без графика. */
  hours: core.ConsultHours;
  /** `booking.consultStripDays`: сколько рабочих дней предлагает мастер. */
  stripDays: number;
}

/** Каталог записи пространства: виды, направления, консультации. Становится полем `BookingSettings.catalog`. */
export interface BookingCatalog {
  eventTypes: readonly EventTypeInfo[];
  directions: readonly { key: string; label: LocalizedLabel }[];
  consult: ConsultSettings;
}

/**
 * Задачи клиента, которые закрывает новая запись или перенос (PROCESS 6.2 «при новой записи», D-204).
 * Закрывает домен записи в своей транзакции через `tasks/auto.closeAutoTasks`; импорт «Записи» — нет.
 */
export const BOOKING_CLOSES_TASK_SOURCES = ['agreement', 'next_step', 'rebook', 'no_show', 'clarify_import'] as const satisfies readonly calling.TaskSource[];

/** Вкладка мастера: подписи уже на языке зрителя (запасной — ru). */
export interface WizardEventType {
  key: string;
  behavior: core.EventBehavior;
  label: string;
  short: string;
  durationMin: number;
}

export interface WizardDirection {
  key: string;
  label: string;
}

/** День полосы заявки на консультацию: только рабочий день, в котором остались слоты. */
export interface ConsultDay {
  /** YYYY-MM-DD в поясе `org.timezone`. */
  date: string;
  /** Старты 'HH:MM' по сетке `consult.slotMinutes` внутри `consult.hours`, только будущие. Сервер примет любой из них. */
  times: string[];
}

/** Предложение мастера для индивидуального вида (B3a: без консультантов и без проверки мест). */
export interface ConsultOffer {
  eventTypeKey: string;
  /** Направления, разрешённые видом, в порядке настроек. */
  directions: WizardDirection[];
  /** Ближайшие `consult.stripDays` рабочих дней (сегодня — если остались слоты). */
  days: ConsultDay[];
  /** Активная будущая запись клиента этого вида: новая заявка станет переносом (D-042). */
  current: BookingView | null;
}

/** Всё, что нужно мастеру на одном экране: `GET /api/bookings/wizard/[cardId]` и страница `/bookings/new/[cardId]`. */
export interface BookingWizardView {
  cardId: string;
  clientId: string;
  /** Название клиента для вопроса подтверждения; карточка видна зрителю по `booking.create`. */
  clientName: string;
  /**
   * `direct` — карточка в `agreed` или `client`: мастер пишет через `POST /api/bookings`;
   * `outcome_required` — записать можно только вместе с итогом «Договорились» из шторки (D-202).
   */
  mode: 'direct' | 'outcome_required';
  /** Вкладки в порядке `booking.eventTypes[]`. */
  types: WizardEventType[];
  /** Групповые виды: ближайшие мероприятия с местами (как `GET /api/events/offer`). */
  groupOffers: (OfferResult & { eventTypeKey: string })[];
  consultOffers: ConsultOffer[];
  /** `org.timezone` — интерфейс форматирует даты в нём, а не в поясе телефона. */
  timeZone: string;
  /** Сегодня в `timeZone` (YYYY-MM-DD): «сегодня» и «завтра» в подписях. */
  today: string;
}

/** Охват: карточка `scopeSql(v,'card','booking.create')`; чужая и несуществующая — `NotFoundError`. */
export type GetBookingWizard = (deps: BookingDeps, viewer: Viewer, input: { cardId: string; locale: string }) => Promise<BookingWizardView>;

/** Полоса дней и сетка времени заявки (чистая функция: настройки + `now`). */
export type ConsultDays = (settings: BookingSettings & { catalog: BookingCatalog }, now: number) => ConsultDay[];

/** Строка минимальных «Записей» (B3a; действия и фильтры — B3b). */
export interface BookingListItem extends BookingView {
  /** Название клиента: строка видна по охвату записи (`scopeSql(v,'booking','booking.read')`). */
  clientName: string;
  /** Консультация без консультанта (`kind = 'individual' AND resource_id IS NULL`). */
  grey: boolean;
}

export type ListBookingItems = (deps: BookingDeps, viewer: Viewer, filter: BookingListFilter) => Promise<BookingListItem[]>;
