/**
 * Снимок дня консультаций и решения над ним: кто свободен, влезет ли «серая» заявка в пул.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/slotsService.ts — только чистая часть
 * (`planFor`, `isFreeAt`, `poolRoom`, `starvedGreyBooking`, `orphanedBookings`, `describeDay`,
 * `assignCandidates`); `loadDay` и SQL не переносятся: снимок собирает репозиторий.
 * Нужна подбору (`suggest`) и автоназначению (`autoAssign`), которые в белом списке.
 *
 * Снимок содержит занимающие место записи индивидуальных видов за ОДНУ дату: «серые»,
 * записи к активным и к выключенным консультантам (последние — orphaned: их надо переназначить).
 */

import type { Consultant, ConsultHours, ScheduleException, ScheduleWindow, SlotBooking } from './types';
import {
  buildSlots,
  countOverlapping,
  defaultHoursDay,
  effectiveDay,
  fitsPlan,
  slotStarts,
  type DayPlan,
  type SlotView,
} from './slots';
import { minToTime, timeToMin } from './time';

export interface ConsultantSchedule {
  schedule: readonly ScheduleWindow[];
  exceptions: readonly ScheduleException[];
}

export interface DaySnapshot {
  date: string;
  /** `booking.consult.hours` — часы консультантов без графика. */
  hours: ConsultHours;
  /** Внедряемый календарь: праздник гасит день у консультантов без графика. */
  isWorkday?: (date: string) => boolean;
  /** Только активные консультанты. */
  consultants: readonly Consultant[];
  schedules: ReadonlyMap<string, ConsultantSchedule>;
  bookings: readonly SlotBooking[];
}

/**
 * План дня: по графику — для консультантов с графиком, по часам настроек — без.
 * Праздник гасит и недельный график консультанта; пробить его может только явное исключение
 * `custom` на эту дату (РОП сознательно открыл окно). `off` и так даёт выходной.
 */
export function planFor(snap: DaySnapshot, c: Consultant): DayPlan {
  if (!c.usesSchedule) return defaultHoursDay(snap.date, snap.hours, snap.isWorkday);
  const data = snap.schedules.get(c.id) ?? { schedule: [], exceptions: [] };
  if (snap.isWorkday && !snap.isWorkday(snap.date)) {
    const opened = data.exceptions.some((e) => e.day === snap.date && e.kind === 'custom');
    if (!opened) return { working: false, windows: [] };
  }
  return effectiveDay(snap.date, data.schedule, data.exceptions);
}

function bookingsOf(snap: DaySnapshot, consultantId: string, excludeBookingId?: string): SlotBooking[] {
  return snap.bookings.filter((b) => b.consultantId === consultantId && b.id !== excludeBookingId);
}

/**
 * Свободен ли консультант для ОСНОВНОЙ записи на [start, start+dur).
 *   • с графиком — start обязан быть стартом его слота, и слот пуст;
 *   • без графика — интервал внутри часов и ни с чем не пересекается.
 */
export function isFreeAt(snap: DaySnapshot, c: Consultant, start: number, durationMin: number, excludeBookingId?: string): boolean {
  if (!c.active) return false;
  const plan = planFor(snap, c);
  const own = bookingsOf(snap, c.id, excludeBookingId);
  if (c.usesSchedule) {
    if (!slotStarts(plan, c.slotMin).includes(start)) return false;
    return countOverlapping(start, c.slotMin, own) === 0;
  }
  return fitsPlan(plan, start, durationMin) && countOverlapping(start, durationMin, own) === 0;
}

/** Сколько «серых» записей ещё влезает в пул (autoAssign) на это время. */
export function poolRoom(snap: DaySnapshot, start: number, durationMin: number): number {
  const free = snap.consultants.filter((c) => c.autoAssign && isFreeAt(snap, c, start, durationMin)).length;
  const unassigned = snap.bookings.filter((b) => b.consultantId === null);
  return free - countOverlapping(start, durationMin, unassigned);
}

/** Как запись ляжет в сетку: к кому, когда и насколько. id — у существующей записи. */
export interface Placement {
  id: string | null;
  consultantId: string;
  startTime: string;
  durationMin: number;
}

/**
 * Отнимет ли запись к консультанту место у «серых» записей пула.
 *
 * Прямая запись к консультанту из пула делает его занятым, а «серые» на это же время
 * рассчитывали на него при проверке ёмкости. Снимок пересчитывается так, будто запись уже
 * легла, и для каждой «серой», пересекающейся с ней, ёмкость пула сравнивается до и после.
 *
 * «Хуже, чем было, и ниже нуля», а не просто «ниже нуля»: если пул уже переполнен не этой
 * записью (консультанта выключили), запись к тому, кто «серым» не помогал, не запрещается.
 *
 * Возвращает «серую» запись, которую некому станет принять, или null.
 */
export function starvedGreyBooking(snap: DaySnapshot, placement: Placement): SlotBooking | null {
  const start = timeToMin(placement.startTime);
  const greys = snap.bookings.filter(
    (b) => b.consultantId === null && b.id !== placement.id && countOverlapping(start, placement.durationMin, [b]) > 0,
  );
  if (greys.length === 0) return null;

  const existing = placement.id ? snap.bookings.find((b) => b.id === placement.id) : undefined;
  const placed: SlotBooking = {
    isReserve: false,
    createdAt: 0,
    directionKey: '',
    ...existing,
    ...placement,
    id: placement.id ?? '',
  };
  const after: DaySnapshot = { ...snap, bookings: [...snap.bookings.filter((b) => b.id !== placement.id), placed] };

  for (const g of greys) {
    const gs = timeToMin(g.startTime);
    const before = poolRoom(snap, gs, g.durationMin);
    const next = poolRoom(after, gs, g.durationMin);
    if (next < 0 && next < before) return g;
  }
  return null;
}

/** Записи дня к консультантам, которых в снимке нет: снимок содержит только активных. */
export function orphanedBookings(snap: DaySnapshot): SlotBooking[] {
  const active = new Set(snap.consultants.map((c) => c.id));
  return snap.bookings.filter((b) => b.consultantId !== null && !active.has(b.consultantId));
}

/** Кандидаты на назначение «серой» записи: только свободные в её время. */
export function assignCandidates(snap: DaySnapshot, booking: Pick<SlotBooking, 'id' | 'startTime' | 'durationMin'>): Consultant[] {
  const start = timeToMin(booking.startTime);
  return snap.consultants.filter((c) => isFreeAt(snap, c, start, booking.durationMin, booking.id));
}

export interface ConsultantDay {
  consultant: Consultant;
  working: boolean;
  /** Часы дня 'HH:MM' (от первого окна до конца последнего) или null, если выходной. */
  hours: { start: string; end: string } | null;
  /** Слоты — только у консультантов с графиком. */
  slots: SlotView[];
  bookings: SlotBooking[];
}

export interface DaySlots {
  date: string;
  consultants: ConsultantDay[];
  unassigned: SlotBooking[];
  /** Записи к выключенным консультантам: без списка их клиенты пропали бы с экрана. */
  orphaned: SlotBooking[];
}

export function describeDay(snap: DaySnapshot, onlyConsultantId?: string): DaySlots {
  const list = onlyConsultantId ? snap.consultants.filter((c) => c.id === onlyConsultantId) : snap.consultants;
  return {
    date: snap.date,
    unassigned: snap.bookings.filter((b) => b.consultantId === null),
    orphaned: orphanedBookings(snap),
    consultants: list.map((c) => {
      const plan = planFor(snap, c);
      const own = bookingsOf(snap, c.id);
      const first = plan.windows[0];
      const last = plan.windows[plan.windows.length - 1];
      return {
        consultant: c,
        working: plan.working,
        hours: plan.working && first && last ? { start: minToTime(first[0]), end: minToTime(last[1]) } : null,
        slots: c.usesSchedule ? buildSlots(plan, c.slotMin, c.capacity, own) : [],
        bookings: own,
      };
    }),
  };
}

/**
 * Резерв: освободился основной слот — старейший резерв становится основным.
 * `slotBookings` — занимающие место записи этого консультанта, пересекающиеся со слотом.
 * Возвращает id резерва для повышения или null (основных мест нет свободных или резерва нет).
 */
export function reserveToPromote(
  slotBookings: readonly Pick<SlotBooking, 'id' | 'isReserve' | 'createdAt'>[],
  capacity: number,
): string | null {
  const main = slotBookings.filter((b) => !b.isReserve).length;
  if (main >= capacity) return null;
  const oldest = slotBookings
    .filter((b) => b.isReserve)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  return oldest ? oldest.id : null;
}
