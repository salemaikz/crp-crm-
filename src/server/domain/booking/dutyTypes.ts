// Дежурство на групповом мероприятии и явка (B4), ночная и утренняя сверка записей (B4b): сигнатуры.
// Дизайн — docs/deals-handoffs-design.md §2–3, решения D-241…D-244. Здесь только типы; тела пишет builder в
// duty.ts, walkIn.ts, sweep.ts, repo.ts (SQL — только в repo.ts). Сигнатуры меняются только через architect.
import type { SystemActor, Viewer } from '@/server/access';
import type { BookingDeps, EventView } from './types';

// ---------------------------------------------------------------------------
// B4: экран «Дежурство»
// ---------------------------------------------------------------------------

/**
 * Мероприятие сегодня, где зритель может отмечать явку: он дежурный (`duty_today`) или у его роли `booking.attend`
 * с охватом `team`/`space`/`all`. Охват `own` мероприятие не открывает — только явку своей записи из карточки (D-317).
 */
export interface DutyEventView extends EventView {
  /** Зритель назначен дежурным (`event_duty`). У РОП без назначения — false. */
  iAmDuty: boolean;
  /** Мероприятие уже началось: «Не пришёл» и «Остальные не пришли» доступны. */
  started: boolean;
  /** Числа по всем записям мероприятия (агрегат без охвата записей, D-136). */
  counts: { unmarked: number; attended: number; noShow: number };
}

/** Сегодняшние мероприятия для экрана «Дежурство», по времени начала. Пусто — «Сегодня вы не дежурите». */
export type ListDutyEvents = (deps: BookingDeps, viewer: Viewer) => Promise<DutyEventView[]>;

/** «Остальные не пришли» (D-242): только записи, которые дежурный видел неотмеченными. */
export interface NoShowRestInput {
  eventId: string;
  /** UUID действия; повтор — по состоянию (уже `no_show` не трогаются). */
  opId: string;
  /** id записей, показанных дежурному без отметки (≤ 1000). */
  bookingIds: readonly string[];
}

export interface NoShowRestResult {
  /** Сколько записей стали «Не пришёл». */
  marked: number;
  /** Из присланных: уже отмечены, отменены, перенесены или не видны дежурному. */
  skipped: number;
}

export type MarkRestNoShow = (deps: BookingDeps, viewer: Viewer, input: NoShowRestInput) => Promise<NoShowRestResult>;

/** Гость без записи (D-241). Номер и имя вводит дежурный; компания — по желанию. */
export interface WalkInInput {
  eventId: string;
  /** UUID попытки; живёт до успеха (как в мастере, D-205). Ключ — `bookings.request_id`. */
  requestId: string;
  phone: string;
  name: string;
  company: string;
}

/**
 * Ответ дежурному. `found` — номер есть у клиента; `new` — создан новый клиент для РОП; `recorded` — сверх
 * лимита проверок номера (D-040): ответ одинаковый при любом исходе, действие то же.
 */
export type WalkInAnswer = 'found' | 'new' | 'recorded';

/**
 * Ответ одной формы при любом исходе (D-301): id записи в нём нет, иначе номер из стоп-листа (записи нет) отличался
 * бы от нового гостя. Гость появляется в списке мероприятия; запись попытки — `booking_history.id = requestId`.
 */
export interface WalkInResult {
  answer: WalkInAnswer;
  replayed: boolean;
}

export type RegisterWalkIn = (deps: BookingDeps, viewer: Viewer, input: WalkInInput) => Promise<WalkInResult>;

/** Дежурные мероприятия и кого можно назначить (РОП, `booking.manage`). Имена сотрудников — не ПДн клиентов. */
export interface DutyCandidates {
  userIds: string[];
  candidates: { userId: string; name: string }[];
}

export type GetDutyCandidates = (deps: BookingDeps, viewer: Viewer, eventId: string) => Promise<DutyCandidates>;

// ---------------------------------------------------------------------------
// B4b: `attendance-sweep` (рабочие дни 10:00) и инвариант «Договорились» (D-049, D-243, D-244)
// ---------------------------------------------------------------------------

export interface SweepReport {
  /** Записи, по которым созданы задачи «Отметьте явку». */
  reminded: number;
  /** Записи, ставшие «Не пришёл» по сроку. */
  marked: number;
  /** Пропущены: уже отмечены, карточка изменилась, нет отметчика. */
  skipped: number;
  /** Проверено карточек `agreed` без шага и создано задач «Записать на следующий шаг». */
  agreedChecked: number;
  nextStepTasks: number;
}

/**
 * Один прогон по пространству: сначала неотмеченная явка (каждая запись — своя транзакция), затем карточки
 * `agreed` без шага. Исполнитель — система воркера; охват не ограничен (scopeSql → TRUE).
 */
export type RunAttendanceSweep = (deps: BookingDeps, actor: SystemActor, input: { spaceId: string; now: number }) => Promise<SweepReport>;

/** Для тревоги РОП «Явка не отмечена» (alarms, поток manager): только число, без id и ПДн. */
export type CountUnmarkedAttendance = (actor: SystemActor, input: { spaceId: string; now: number; today: string }) => Promise<number>;

/** Часть ночной сверки `invariants`: карточки `agreed` без активной будущей записи и без открытой задачи со сроком. */
export type CountAgreedWithoutStep = (actor: SystemActor) => Promise<number>;

/**
 * Сколько рабочих дней прошло после даты мероприятия: рабочие дни строго после `day` и не позже `today`.
 * Чт 29.10 → пт 30.10 = 1, пн 02.11 = 2 (сб и вс не считаются). Чистая функция.
 */
export type WorkdaysAfter = (calendar: { isWorkday(day: string): boolean }, day: string, today: string) => number;
