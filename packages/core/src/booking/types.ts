/**
 * Запись на мероприятия: словарь домена.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/types.ts (приведён к PROCESS §5 и CONFIG §6.9).
 *
 * Отличия от исходника:
 *   • виды мероприятий — данные настроек (`booking.eventTypes[]`), а не union в коде;
 *     в коде остаётся только поведение вида: group (общее, с вместимостью) и individual (слоты консультанта);
 *   • статусов шесть: `moved_*` слиты в `moved` (схема v1, bookings_status_check);
 *   • направления — ключи `booking.directions[]` (строки), а не закрытый union;
 *   • без БД-полей репозитория: ядро получает «лёгкие» срезы, нужные для решений.
 *
 * Модуль чистый: без node:*, Next и БД.
 */

/** Поведение вида мероприятия: group — общее с вместимостью, individual — слот консультанта. */
export const EVENT_BEHAVIORS = ['group', 'individual'] as const;
export type EventBehavior = (typeof EVENT_BEHAVIORS)[number];

/** Статусы записи (PROCESS §5.3). Одни и те же для обоих поведений. */
export const BOOKING_STATUSES = ['registered', 'confirmed', 'attended', 'no_show', 'cancelled', 'moved'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Статусы, в которых запись ДЕРЖИТ место: стул в зале или слот консультанта.
 * «Не пришёл» тоже держит: время прошло, вместимость прошедшего мероприятия
 * не должна «освобождаться» задним числом. Отмена и перенос место освобождают.
 */
export const OCCUPYING_STATUSES = ['registered', 'confirmed', 'attended', 'no_show'] as const satisfies readonly BookingStatus[];

export function isOccupying(status: BookingStatus): boolean {
  return (OCCUPYING_STATUSES as readonly string[]).includes(status);
}

/** «Активная» запись клиента: ещё может состояться (из неё делается перенос, ей шлют напоминания). */
export const ACTIVE_STATUSES = ['registered', 'confirmed'] as const satisfies readonly BookingStatus[];

export function isActive(status: BookingStatus): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Причина отмены (bookings.cancel_reason); '' — не отмена или причина не указана. */
export const CANCEL_REASONS = ['', 'client', 'event_cancelled', 'operator_error', 'do_not_call'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** Статусы мероприятия. */
export const EVENT_STATUSES = ['scheduled', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Вид исключения графика консультанта: off — выходной/отпуск, custom — особые окна. */
export const EXCEPTION_KINDS = ['off', 'custom'] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Режим утреннего назначения «серых» записей: assign — назначать, suggest — только предлагать РОП. */
export const GREY_MODES = ['assign', 'suggest'] as const;
export type GreyMode = (typeof GREY_MODES)[number];

// ---------------------------------------------------------------------------
// Настройки (срез `booking.*` и `reminders.*` из CONFIG §6.9)
// ---------------------------------------------------------------------------

export interface EventTypeConfig {
  key: string;
  behavior: EventBehavior;
  label: string;
  short: string;
  capacity?: number;
  durationMin: number;
}

export interface DirectionConfig {
  key: string;
  label: string;
}

export interface TimeRange {
  /** 'HH:MM'. */
  start: string;
  end: string;
}

/** `booking.consult.hours`: рабочие дни ISO (1 = пн) и часы консультантов без графика. */
export interface ConsultHours {
  workdays: readonly number[];
  start: string;
  end: string;
}

/** `booking.grey.schedule`: прогоны автоназначения «серых» заявок. */
export interface GreySchedule {
  first: string;
  last: string;
  stepMin: number;
}

export type ReminderDay = 'today' | 'tomorrow';

export interface ReminderTemplate {
  key: string;
  /** Ключ вида мероприятия; пусто — общий текст для всех видов. */
  eventTypeKey: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Рабочие данные
// ---------------------------------------------------------------------------

export interface EventSeries {
  id: string;
  eventTypeKey: string;
  /** ISO-день недели 1..7. */
  weekday: number;
  startTime: string;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  active: boolean;
}

/** Мероприятие (строка events) в объёме, нужном ядру. */
export interface EventLite {
  id: string;
  seriesId: string | null;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  startsAt: number;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  status: EventStatus;
  occurrenceKey: string | null;
  /** Ручная правка: генерация такое мероприятие не трогает. */
  touched: boolean;
}

/** Консультант (resources) — решения подбора и слотов. */
export interface Consultant {
  id: string;
  name: string;
  /** Ключи `booking.directions[]`, в которых консультант силён. */
  directions: readonly string[];
  slotMin: number;
  /** Вместимость слота: 1 — основной, второй клиент — резерв. */
  capacity: number;
  /** Есть недельный график; без него — часы `booking.consult.hours`. */
  usesSchedule: boolean;
  /** Участвует в автоназначении (resources.auto_assign). */
  autoAssign: boolean;
  active: boolean;
  sort: number;
}

/** Окно недельного графика (resource_schedule). Перерыв — промежуток между окнами. */
export interface ScheduleWindow {
  weekday: number;
  start: string;
  end: string;
}

/** Исключение на дату (resource_exceptions): выходной/отпуск или особые окна. */
export interface ScheduleException {
  day: string;
  kind: ExceptionKind;
  windows: readonly TimeRange[];
}

/** Запись консультации в объёме, нужном слотам и подбору (один день). */
export interface SlotBooking {
  id: string;
  /** null — «серая» заявка: консультанта назначат позже. */
  consultantId: string | null;
  startTime: string;
  durationMin: number;
  isReserve: boolean;
  createdAt: number;
  /** Ключ направления запроса клиента; '' — не выбран. */
  directionKey: string;
}
