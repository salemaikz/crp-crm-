// Консультации (B5): консультанты, график, мастер с подбором, «серые» и автоназначение, экран консультанта.
// Дизайн — docs/deals-handoffs-design.md §4, решения D-245…D-247. Здесь только типы и сигнатуры; тела — builder в
// consultants.ts, consultDay.ts, assign.ts, greyJob.ts, consultations.ts, repo.ts. Меняются только через architect.
// Чистые решения (слоты, подбор, пул «серых», резерв) — в ядре `booking` (K1b): здесь их не повторяем.
import type { booking as core } from '@crm/core';
import type { SystemActor, Viewer } from '@/server/access';
import type { BookingDeps, BookingView } from './types';

// ---------------------------------------------------------------------------
// Консультанты (B5a — к пилоту, без флага)
// ---------------------------------------------------------------------------

export interface ConsultantView {
  id: string;
  userId: string;
  /** Имя сотрудника (users.name). */
  name: string;
  directions: string[];
  slotMin: number;
  /** 1 — основной; больше — резерв в слоте. */
  capacity: number;
  autoAssign: boolean;
  active: boolean;
  sort: number;
  /** Есть недельный график; без него работают часы `booking.consult.hours`. */
  usesSchedule: boolean;
  /** Токен оптимистичной правки (у resources нет version). */
  updatedAt: number;
}

export interface ConsultantInput {
  /** id консультанта = ключ запроса (UUID): повтор не создаёт второго. */
  requestId: string;
  /** Сотрудник с активным членством в пространстве; один ресурс на сотрудника (UNIQUE space_id, user_id). */
  userId: string;
  directions: readonly string[];
  slotMin: number;
  capacity: number;
  autoAssign: boolean;
  sort: number;
}

export type ConsultantPatch = Partial<Pick<ConsultantInput, 'directions' | 'slotMin' | 'capacity' | 'autoAssign' | 'sort'>> & { active?: boolean };

export type ListConsultants = (deps: BookingDeps, viewer: Viewer, opts: { includeInactive: boolean }) => Promise<ConsultantView[]>;
export type CreateConsultant = (deps: BookingDeps, viewer: Viewer, input: ConsultantInput) => Promise<ConsultantView>;
export type UpdateConsultant = (deps: BookingDeps, viewer: Viewer, input: { resourceId: string; seenUpdatedAt: number; patch: ConsultantPatch }) => Promise<ConsultantView>;

// ---------------------------------------------------------------------------
// График и исключения (B5b, за FEATURE_BK_WIZARD)
// ---------------------------------------------------------------------------

export interface ScheduleWindowInput {
  weekday: number;
  start: string;
  end: string;
}

export interface ConsultantSchedule {
  resourceId: string;
  windows: ScheduleWindowInput[];
  /** Исключения от сегодня и дальше, по дате. */
  exceptions: { day: string; kind: core.ExceptionKind; windows: core.TimeRange[] }[];
}

/** Неделя целиком: старые окна удаляются, новые вставляются (DELETE у resource_schedule разрешён). Пусто — без графика. */
export type SetSchedule = (deps: BookingDeps, viewer: Viewer, input: { resourceId: string; windows: readonly ScheduleWindowInput[] }) => Promise<ConsultantSchedule>;
/** `windows` пусто при `off`; при `custom` — не пусто, без пересечений. */
export type SetException = (deps: BookingDeps, viewer: Viewer, input: { resourceId: string; day: string; kind: core.ExceptionKind; windows: readonly core.TimeRange[] }) => Promise<ConsultantSchedule>;
export type ClearException = (deps: BookingDeps, viewer: Viewer, input: { resourceId: string; day: string }) => Promise<ConsultantSchedule>;
export type GetSchedule = (deps: BookingDeps, viewer: Viewer, resourceId: string) => Promise<ConsultantSchedule>;

// ---------------------------------------------------------------------------
// День консультаций: снимок под блокировкой дня (D-245)
// ---------------------------------------------------------------------------

/** Запись дня глазами РОП: клиент — по охвату записи (у РОП — пространство). */
export interface ConsultDayBooking {
  bookingId: string;
  resourceId: string | null;
  startTime: string;
  durationMin: number;
  isReserve: boolean;
  status: core.BookingStatus;
  directionKey: string;
  clientName: string;
  version: number;
}

export interface ConsultDayView {
  date: string;
  consultants: {
    resourceId: string;
    name: string;
    working: boolean;
    hours: { start: string; end: string } | null;
    slots: core.SlotView[];
    bookings: ConsultDayBooking[];
  }[];
  /** «Серые» дня. */
  unassigned: ConsultDayBooking[];
  /** Записи к выключенным консультантам или выпавшие из графика (12.27): их надо переназначить. */
  conflicts: ConsultDayBooking[];
}

/** Экран дня для РОП (`booking.manage`): кто свободен, «серые», конфликты. */
export type GetConsultDay = (deps: BookingDeps, viewer: Viewer, input: { date: string }) => Promise<ConsultDayView>;

// ---------------------------------------------------------------------------
// Мастер с подбором (за FEATURE_BK_WIZARD; без флага — сетка B3a, D-203)
// ---------------------------------------------------------------------------

export interface SuggestedConsultant {
  resourceId: string;
  name: string;
  directionMatch: boolean;
  /** Запись ляжет резервом (слот занят, вместимость > 1). */
  reserve: boolean;
}

export interface ConsultSlotOption {
  /** 'HH:MM': сервер примет запись на это время. */
  time: string;
  /** Лучший по подбору (направление → загрузка дня → порядок → имя); null — только «серая». */
  suggested: SuggestedConsultant | null;
  /** Остальные подходящие, в порядке подбора (≤ 5). */
  others: SuggestedConsultant[];
  /** «Назначим утром»: в пуле автоназначения на это время есть место (`poolRoom > 0`). */
  greyAllowed: boolean;
}

export interface ConsultStripDay {
  date: string;
  slots: ConsultSlotOption[];
  /** Когда подберут консультанта «серой» на этот день (`core.greyTiming`). */
  greyTiming: core.GreyTiming;
}

/** Полоса дней с подбором для карточки (`booking.create` по карточке; консультант — только к себе, D-246). */
export type GetConsultStrip = (
  deps: BookingDeps,
  viewer: Viewer,
  input: { cardId: string; eventTypeKey: string; directionKey: string },
) => Promise<{ days: ConsultStripDay[]; current: BookingView | null }>;

// ---------------------------------------------------------------------------
// Назначение консультанта, резерв
// ---------------------------------------------------------------------------

export interface AssignInput {
  bookingId: string;
  opId: string;
  version: number;
  resourceId: string;
}

/** Ручное назначение и переназначение (РОП, `booking.manage`). Освобождённый слот повышает резерв. */
export type AssignConsultant = (deps: BookingDeps, viewer: Viewer, input: AssignInput) => Promise<BookingView>;
/** Кому можно отдать запись сейчас (`core.rankAssignCandidates`), лучший первым. */
export type ListAssignCandidates = (deps: BookingDeps, viewer: Viewer, bookingId: string) => Promise<SuggestedConsultant[]>;

// ---------------------------------------------------------------------------
// Автоназначение «серых» (job `grey-assign`, D-247)
// ---------------------------------------------------------------------------

export interface GreyRunReport {
  date: string;
  mode: core.GreyMode;
  assigned: number;
  suggested: number;
  unassignable: number;
}

export type RunGreyAssign = (deps: BookingDeps, actor: SystemActor, input: { spaceId: string; now: number }) => Promise<GreyRunReport>;

// ---------------------------------------------------------------------------
// Экран консультанта «Мои консультации» (D-246)
// ---------------------------------------------------------------------------

export interface MyConsultation {
  bookingId: string;
  bookingDate: string;
  startTime: string;
  durationMin: number;
  status: core.BookingStatus;
  directionKey: string;
  isReserve: boolean;
  version: number;
  /** Внутри окна консультанта (PROCESS 8.4): клиент открыт. Вне окна — null у всех полей клиента. */
  inWindow: boolean;
  clientId: string | null;
  cardId: string | null;
  clientName: string | null;
  dealId: string | null;
}

/** Своё расписание: записи к своему ресурсу в окне дат (≤ 62 дня), без охвата записей (D-246). */
export type ListMyConsultations = (deps: BookingDeps, viewer: Viewer, input: { from: string; to: string }) => Promise<MyConsultation[]>;

/** Итог встречи: заметка, следующий шаг, следующий этап воронки (PROCESS 2.8). */
export interface ConsultResultInput {
  bookingId: string;
  /** UUID; ключ — `client_events.id` события `booking.result` (D-248). */
  opId: string;
  note: string;
  nextStep: { dueAt: number; kind: 'call' | 'meeting' } | null;
  /** Ключ открытого этапа воронки (в пресете продаж: `offer`); null — этап не меняем. */
  toStageKey: string | null;
  /** Версия сделки записи, если меняем этап. */
  dealVersion: number | null;
}

export type RecordConsultResult = (deps: BookingDeps, viewer: Viewer, input: ConsultResultInput) => Promise<{ bookingId: string; noteId: string; taskId: string | null; replayed: boolean }>;

// ---------------------------------------------------------------------------
// Срез настроек, которого нет в BookingSettings (без правки types.ts)
// ---------------------------------------------------------------------------

export interface BookingOpsSettings {
  spaceId: string;
  grey: { mode: core.GreyMode; schedule: core.GreySchedule };
  /** `booking.duty.defaultRole`: отметчик по умолчанию для группового мероприятия без дежурных. */
  dutyDefaultRole: string;
  /** `booking.attendance.autoNoShowWorkdays`; null — автонеявка выключена (аварийный выключатель, D-243). */
  autoNoShowWorkdays: number | null;
  /** `security.phoneProbesPerDay` (D-040). */
  phoneProbesPerDay: number;
  /** Ключ источника вида `walk_in` из `sources[]`; null — источника нет в настройках (гость → ошибка настроек). */
  walkInSourceKey: string | null;
}

export type LoadBookingOpsSettings = (spaceId: string, now: number) => Promise<BookingOpsSettings>;

/** Коды ошибок B4/B5 сверх BookingDomainErrorCode (HTTP — дизайн §6). */
export const CONSULT_DOMAIN_ERRORS = [
  'slot_taken',
  'pool_full',
  'consultant_inactive',
  'consultant_exists',
  'schedule_overlap',
  'not_attended',
  'walk_in_closed',
  'walk_in_source_missing',
] as const;
export type ConsultDomainErrorCode = (typeof CONSULT_DOMAIN_ERRORS)[number];
