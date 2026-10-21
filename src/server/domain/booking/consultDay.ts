// День консультаций (B5b, docs/deals-handoffs-design.md §4.5–4.6, D-245): блокировка дня, снимок под ней,
// решение о записи (пул «серых», подбор), экран дня РОП и полоса подбора мастера.
// Чистые решения — в ядре `booking` (слоты, ранг, пул); здесь сборка снимка из строк БД и вызовы ядра.
import { booking as core } from '@crm/core';
import { BadRequestError, NotFoundError, scopeOf } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { checkConsultWindow, consultDaySlots } from './consult';
import type { ConsultDayBooking, ConsultDayView, ConsultSlotOption, ConsultStripDay, GetConsultDay, GetConsultStrip, SuggestedConsultant } from './consultTypes';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import { loadBookingOpsSettings } from './opsSettings';
import {
  findResourceByUser,
  findWizardCard,
  listActiveFutureBookings,
  listResourceRows,
  setLockTimeout10s,
  toBookingView,
  type ResourceListRow,
} from './repo';
import {
  listDayBookings,
  listDayDetails,
  listExceptionsOfDay,
  listScheduleOfWeekday,
  lockConsultDayRow,
  type DayBookingRow,
  type ExceptionRow,
  type ScheduleRow,
} from './repo.consult';
import { inBookingTx } from './tx';
import type { BookingSettings, EventTypeInfo } from './types';

/** Настройки, нужные снимку: часы консультантов без графика и рабочий календарь. */
type DaySettings = BookingSettings;

// ---------------------------------------------------------------------------
// Блокировка и снимок
// ---------------------------------------------------------------------------

/**
 * Блокировка дня консультаций (D-245). Транзакция, берущая advisory, ограничивает ожидание 10 с (D-251).
 * Порядок: карточки → день → записи. Несколько дат — в порядке дат.
 */
export async function lockConsultDay(tx: Sql, spaceId: string, date: string): Promise<void> {
  await setLockTimeout10s(tx);
  await lockConsultDayRow(tx, spaceId, date);
}

export async function lockConsultDays(tx: Sql, spaceId: string, dates: Iterable<string>): Promise<void> {
  for (const d of [...new Set(dates)].sort()) await lockConsultDay(tx, spaceId, d);
}

/** Окна исключения из jsonb: `{start,end}` (наш формат) или `{from,to}` (комментарий схемы). Мусор отбрасывается. */
export function parseExceptionWindows(raw: unknown): core.TimeRange[] {
  if (!Array.isArray(raw)) return [];
  const out: core.TimeRange[] = [];
  for (const w of raw as Record<string, unknown>[]) {
    const start = w?.start ?? w?.from;
    const end = w?.end ?? w?.to;
    if (typeof start === 'string' && typeof end === 'string' && core.isLocalTime(start) && core.isLocalTime(end) && start < end) out.push({ start, end });
  }
  return out;
}

export const toCoreConsultant = (r: ResourceListRow): core.Consultant => ({
  id: r.id,
  name: r.name,
  directions: r.directions,
  slotMin: r.slotMin,
  capacity: r.capacity,
  usesSchedule: r.usesSchedule,
  autoAssign: r.autoAssign,
  active: r.active,
  sort: r.sort,
});

export const toSlotBooking = (r: DayBookingRow): core.SlotBooking => ({
  id: r.id,
  consultantId: r.resourceId,
  startTime: r.startTime,
  durationMin: r.durationMin,
  isReserve: r.isReserve,
  createdAt: r.createdAt,
  directionKey: r.directionKey,
});

/** Чистая сборка снимка из строк БД. Консультанты снимка — только активные; выключенные нужны лишь для «конфликтов». */
export function buildDaySnapshot(a: {
  date: string;
  settings: DaySettings;
  resources: readonly ResourceListRow[];
  schedule: readonly ScheduleRow[];
  exceptions: readonly ExceptionRow[];
  bookings: readonly DayBookingRow[];
}): core.DaySnapshot {
  const active = a.resources.filter((r) => r.active);
  const schedules = new Map<string, core.ConsultantSchedule>();
  for (const r of active) {
    schedules.set(r.id, {
      schedule: a.schedule.filter((s) => s.resourceId === r.id).map((s) => ({ weekday: s.weekday, start: s.startTime, end: s.endTime })),
      exceptions: a.exceptions.filter((e) => e.resourceId === r.id).map((e) => ({ day: e.day, kind: e.kind, windows: parseExceptionWindows(e.windows) })),
    });
  }
  const { hours } = a.settings.catalog.consult;
  return {
    date: a.date,
    hours: { workdays: hours.workdays, start: hours.start, end: hours.end },
    isWorkday: (d) => a.settings.calendar.isWorkday(d),
    consultants: active.map(toCoreConsultant),
    schedules,
    bookings: a.bookings.map(toSlotBooking),
  };
}

export interface LoadedDay {
  snapshot: core.DaySnapshot;
  /** Все консультанты пространства, включая выключенных. */
  resources: ResourceListRow[];
}

/** Читает день ПОСЛЕ блокировки (D-245): консультанты, график на день недели, исключения, записи. */
export async function loadDay(tx: Sql, spaceId: string, date: string, settings: DaySettings, preloaded?: ResourceListRow[]): Promise<LoadedDay> {
  const resources = preloaded ?? (await listResourceRows(tx, { spaceId, includeInactive: true }));
  const activeIds = resources.filter((r) => r.active).map((r) => r.id);
  const [schedule, exceptions, bookings] = await Promise.all([
    listScheduleOfWeekday(tx, { ids: activeIds, weekday: core.isoWeekday(date) }),
    listExceptionsOfDay(tx, { ids: activeIds, day: date }),
    listDayBookings(tx, { spaceId, date, allIds: resources.map((r) => r.id) }),
  ]);
  return { snapshot: buildDaySnapshot({ date, settings, resources, schedule, exceptions, bookings }), resources };
}

export async function loadDaySnapshot(tx: Sql, spaceId: string, date: string, settings: DaySettings): Promise<core.DaySnapshot> {
  return (await loadDay(tx, spaceId, date, settings)).snapshot;
}

// ---------------------------------------------------------------------------
// Решение о записи
// ---------------------------------------------------------------------------

export const toSuggested = (r: core.RankedConsultant): SuggestedConsultant => ({
  resourceId: r.consultantId,
  name: r.name,
  directionMatch: r.directionMatch,
  reserve: r.reserve,
});

export interface ConsultPlacement {
  resourceId: string | null;
  isReserve: boolean;
  durationMin: number;
  /** «Серая» после последнего прогона автоназначения: консультанта назначит РОП (задача). */
  greyTooLate: boolean;
}

/**
 * Решение по снимку (§4.6): «серая» — пул обязан вместить заявку, иначе `pool_full`; к консультанту — он обязан
 * быть в ранге на это время, иначе `slot_taken` с тремя первыми из ранга. Исключает из снимка переносимую запись.
 */
export function decideConsultPlacement(a: {
  snapshot: core.DaySnapshot;
  settings: DaySettings;
  ops: { grey: { schedule: core.GreySchedule } };
  type: Pick<EventTypeInfo, 'durationMin'>;
  directionKey: string;
  date: string;
  time: string;
  now: number;
  resourceId: string | null;
  resources: readonly ResourceListRow[];
  /** Переносимая запись: она освобождается, в снимке её нет. */
  excludeBookingId: string | null;
}): ConsultPlacement {
  const snap: core.DaySnapshot = a.excludeBookingId ? { ...a.snapshot, bookings: a.snapshot.bookings.filter((b) => b.id !== a.excludeBookingId) } : a.snapshot;
  const start = core.timeToMin(a.time);
  if (a.resourceId === null) {
    if (core.poolRoom(snap, start, a.type.durationMin) <= 0) throw new BookingDomainError('pool_full');
    const timing = core.greyTiming(a.date, a.now, a.ops.grey.schedule, a.settings.timeZone, (d) => a.settings.calendar.isWorkday(d));
    return { resourceId: null, isReserve: false, durationMin: a.type.durationMin, greyTooLate: timing === 'too_late' };
  }
  const res = a.resources.find((r) => r.id === a.resourceId && r.active);
  if (!res) throw new BookingDomainError('consultant_not_found');
  // Консультант без графика принимает только по сетке часов, как «серая» (D-203)
  if (!res.usesSchedule && !consultDaySlots(a.settings, a.date).includes(a.time)) throw new BookingDomainError('outside_hours');
  const rank = core.rankConsultants(snap, { startTime: a.time, durationMin: a.type.durationMin }, a.directionKey);
  const hit = rank.find((r) => r.consultantId === res.id);
  if (!hit) throw new BookingDomainError('slot_taken', undefined, rank.slice(0, 3).map(toSuggested));
  return { resourceId: res.id, isReserve: hit.reserve, durationMin: res.usesSchedule ? res.slotMin : a.type.durationMin, greyTooLate: false };
}

// ---------------------------------------------------------------------------
// Экран дня РОП
// ---------------------------------------------------------------------------

/** Запись не вписывается в рабочие часы своего консультанта (график изменили после записи, 12.27). */
function outsideWorkPlan(snap: core.DaySnapshot, c: core.Consultant, b: core.SlotBooking): boolean {
  const plan = core.planFor(snap, c);
  const start = core.timeToMin(b.startTime);
  return c.usesSchedule ? !core.slotStarts(plan, c.slotMin).includes(start) : !core.fitsPlan(plan, start, b.durationMin);
}

export const getConsultDay: GetConsultDay = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  if (!core.isLocalDate(input.date)) throw new BadRequestError('date');
  const settings = await deps.settings(spaceId, deps.now());
  return inBookingTx({}, async (tx): Promise<ConsultDayView> => {
    const { snapshot: snap } = await loadDay(tx, spaceId, input.date, settings);
    const day = core.describeDay(snap);
    const ids = snap.bookings.map((b) => b.id);
    const details = new Map((await listDayDetails(viewer, tx, ids)).map((d) => [d.id, d]));
    const view = (b: core.SlotBooking): ConsultDayBooking => {
      const d = details.get(b.id);
      return {
        bookingId: b.id,
        resourceId: b.consultantId,
        startTime: b.startTime,
        durationMin: b.durationMin,
        isReserve: b.isReserve,
        status: d?.status ?? 'registered',
        directionKey: b.directionKey,
        clientName: d?.clientName ?? '',
        version: d?.version ?? 0,
      };
    };
    // Прошедшие и отмеченные записи не «конфликт»: переназначать нечего
    const live = (b: ConsultDayBooking) => b.status === 'registered' || b.status === 'confirmed';
    const conflicts: ConsultDayBooking[] = day.orphaned.map(view).filter(live);
    const consultants = day.consultants.map((cd) => {
      const mine = cd.bookings.map((b) => ({ raw: b, v: view(b) }));
      const dropped = mine.filter((m) => live(m.v) && outsideWorkPlan(snap, cd.consultant, m.raw));
      conflicts.push(...dropped.map((m) => m.v));
      return {
        resourceId: cd.consultant.id,
        name: cd.consultant.name,
        working: cd.working,
        hours: cd.hours,
        slots: cd.slots,
        bookings: mine.filter((m) => !dropped.includes(m)).map((m) => m.v),
      };
    });
    return { date: input.date, consultants, unassigned: day.unassigned.map(view), conflicts: conflicts.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.bookingId.localeCompare(b.bookingId)) };
  });
};

// ---------------------------------------------------------------------------
// Полоса подбора мастера записи
// ---------------------------------------------------------------------------

/** Времена дня в полосе: сетка `consult.hours` плюс старты слотов консультантов с графиком. */
export function stripTimes(snap: core.DaySnapshot, settings: DaySettings): { all: string[]; grid: Set<string> } {
  const grid = new Set(consultDaySlots(settings, snap.date));
  const all = new Set(grid);
  for (const c of snap.consultants) {
    if (!c.usesSchedule) continue;
    for (const m of core.slotStarts(core.planFor(snap, c), c.slotMin)) all.add(core.minToTime(m));
  }
  return { all: [...all].sort(), grid };
}

/** Одно время полосы или null, если на него записать нельзя. `only` — консультант по отношению: виден лишь он. */
export function stripOption(a: {
  snap: core.DaySnapshot;
  time: string;
  grid: Set<string>;
  durationMin: number;
  directionKey: string;
  only: string | null;
}): ConsultSlotOption | null {
  const ranked = core.rankConsultants(a.snap, { startTime: a.time, durationMin: a.durationMin }, a.directionKey).filter((r) => a.only === null || r.consultantId === a.only);
  const greyAllowed = a.only === null && a.grid.has(a.time) && core.poolRoom(a.snap, core.timeToMin(a.time), a.durationMin) > 0;
  if (ranked.length === 0 && !greyAllowed) return null;
  const list = ranked.map(toSuggested);
  return { time: a.time, suggested: list[0] ?? null, others: list.slice(1, 6), greyAllowed };
}

export const getConsultStrip: GetConsultStrip = async (deps, viewer, input) => {
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const ops = await loadBookingOpsSettings(spaceId, now);
  return inBookingTx({}, async (tx) => {
    const card = await findWizardCard(viewer, tx, { spaceId, cardId: input.cardId });
    if (!card) throw new NotFoundError();
    // Вид и направление проверяем после карточки: чужая и несуществующая отвечают 404 раньше плохого запроса
    const type = settings.catalog.eventTypes.find((t) => t.key === input.eventTypeKey);
    if (!type || type.behavior !== 'individual') throw new BookingDomainError('not_an_individual_event');
    const known = settings.catalog.directions.some((d) => d.key === input.directionKey);
    if (!known || (type.directions.length > 0 && !type.directions.includes(input.directionKey))) throw new BadRequestError('direction');
    // Консультант по отношению (без гранта роли) записывает клиента только к себе (D-246)
    let only: string | null = null;
    if (scopeOf(viewer, 'booking.create') === null) {
      const mine = await findResourceByUser(tx, { spaceId, userId: viewer.userId });
      if (!mine || !mine.active) throw new NotFoundError();
      only = mine.id;
    }
    const resources = await listResourceRows(tx, { spaceId, includeInactive: true });
    const today = core.epochToLocalDate(settings.timeZone, now);
    const days: ConsultStripDay[] = [];
    for (let i = 0; i <= settings.horizonDays && days.length < settings.catalog.consult.stripDays; i++) {
      const date = core.addDays(today, i);
      const { snapshot: snap } = await loadDay(tx, spaceId, date, settings, resources);
      const { all, grid } = stripTimes(snap, settings);
      const slots: ConsultSlotOption[] = [];
      for (const time of all) {
        if (checkConsultWindow(settings, date, time, now) !== 'ok') continue;
        const opt = stripOption({ snap, time, grid, durationMin: type.durationMin, directionKey: input.directionKey, only });
        if (opt) slots.push(opt);
      }
      if (slots.length === 0) continue;
      days.push({
        date,
        slots,
        greyTiming: core.greyTiming(date, now, ops.grey.schedule, settings.timeZone, (d) => settings.calendar.isWorkday(d)),
        greyStepMin: ops.grey.schedule.stepMin,
      });
    }
    const active = await listActiveFutureBookings(viewer, tx, { spaceId, clientId: card.clientId, now, perm: 'booking.create', kind: 'individual' });
    const current = active.find((b) => b.eventTypeKey === type.key) ?? null;
    return { days, current: current ? toBookingView(current) : null };
  });
};
