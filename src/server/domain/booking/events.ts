// Мероприятия: список, предложение в мастере, разовое, правка, отмена каскадом, дежурные, гости
// (docs/booking-design.md §5.4–5.6, D-131, D-135, D-136, D-137).
import { booking } from '@crm/core';
import { BadRequestError, ConflictError, NotFoundError, type Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import {
  actorUserId,
  activeCardIdsOfEvent,
  activeMemberIds,
  auditEvent,
  cancelBookingRows,
  cancelEventRow,
  countTaken,
  findCardByClient,
  findEvent,
  findEventPlain,
  hasOtherFutureBooking,
  insertEvent,
  insertFeed,
  insertHistory,
  latestActiveSeriesOfType,
  listActiveFutureBookings,
  listBookableEventRows,
  listDutyUserIds,
  listEventRows,
  listGuestRows,
  lockActiveBookingsOfEvent,
  lockEventCardsInOrder,
  replaceDuty,
  toBookingView,
  toEventLite,
  toEventOption,
  toEventView,
  updateEventRow,
  type EventRow,
  type EventRowWithTaken,
} from './repo';
import { inBookingTx } from './tx';
import { noteCardEvent } from './cardEvents';
import {
  EVENT_FORMATS,
  type BookingActor,
  type BookingSettings,
  type CancelEvent,
  type CancelEventResult,
  type CreateEvent,
  type EventInput,
  type EventOption,
  type GetEvent,
  type ListEvents,
  type ListGuests,
  type OfferEvents,
  type OfferResult,
  type SetEventDuty,
  type UpdateEvent,
} from './types';

const MAX_WINDOW_DAYS = 62;
const MAX_DUTY = 10;

const eventNotFound = () => new BookingDomainError('event_not_found');

/** Ближайшие мероприятия вида с местами: мастер записи и `alternatives` ответа `event_full` (§5.6). */
export async function nearestOptions(
  actor: BookingActor,
  sql: Sql,
  a: { spaceId: string; settings: BookingSettings; eventTypeKey: string | null; now: number },
): Promise<EventOption[]> {
  const lastDate = booking.addDays(booking.epochToLocalDate(a.settings.timeZone, a.now), a.settings.horizonDays);
  const rows = await listBookableEventRows(actor, sql, { spaceId: a.spaceId, now: a.now, lastDate, eventTypeKey: a.eventTypeKey });
  const byId = new Map<string, EventRowWithTaken>(rows.map((r) => [r.id, r]));
  const lite = rows.map((r) => ({ ...toEventLite(r), taken: r.taken }));
  return booking
    .offerEvents(lite, a.now, a.settings.groupOptions, a.eventTypeKey ?? undefined)
    .map((e) => toEventOption(byId.get(e.id) as EventRowWithTaken));
}

/** Предложение мастера внутри открытой транзакции чтения: ближайшие с местами и текущая запись вида. */
export async function offerInTx(
  viewer: Viewer,
  tx: Sql,
  a: { spaceId: string; clientId: string; settings: BookingSettings; eventTypeKey: string | null; now: number },
): Promise<OfferResult> {
  const options = await nearestOptions(viewer, tx, { spaceId: a.spaceId, settings: a.settings, eventTypeKey: a.eventTypeKey, now: a.now });
  const active = await listActiveFutureBookings(viewer, tx, { spaceId: a.spaceId, clientId: a.clientId, now: a.now, perm: 'booking.create' });
  const current = active.find((b) => a.eventTypeKey === null || b.eventTypeKey === a.eventTypeKey) ?? null;
  return { options, current: current ? toBookingView(current) : null };
}

export const offerEvents: OfferEvents = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.create', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const type = input.eventTypeKey ?? null;
  if (type !== null && !settings.groupTypes.some((t) => t.key === type)) throw new BookingDomainError('invalid_settings');
  return inBookingTx({}, async (tx): Promise<OfferResult> => {
    // Карточка клиента должна быть видна по booking.create, иначе клиент «не существует».
    const card = await findCardByClient(viewer, tx, { spaceId, clientId: input.clientId, perm: 'booking.create', lock: false });
    if (!card) throw new NotFoundError();
    return offerInTx(viewer, tx, { spaceId, clientId: input.clientId, settings, eventTypeKey: type, now });
  });
};

function assertWindow(from: string, to: string): void {
  if (!booking.isLocalDate(from) || !booking.isLocalDate(to) || from > to) throw new BadRequestError('window');
  if (booking.addDays(from, MAX_WINDOW_DAYS) < to) throw new BadRequestError('window');
}

export const listEvents: ListEvents = async (_deps, viewer, filter) => {
  const spaceId = requireSpace(viewer);
  assertWindow(filter.from, filter.to);
  const rows = await inBookingTx({}, (tx) =>
    listEventRows(viewer, tx, { spaceId, from: filter.from, to: filter.to, eventTypeKey: filter.eventTypeKey ?? null, includeCancelled: filter.includeCancelled ?? false }),
  );
  return rows.map((r) => toEventView(r, r.taken));
};

export const getEvent: GetEvent = async (viewer, eventId) => {
  requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const row = await findEvent(viewer, tx, { eventId, perm: 'booking.read', lock: false });
    if (!row) throw eventNotFound();
    return toEventView(row, await countTaken(tx, row.id));
  });
};

/** Умолчания места и формата: действующая серия вида, затем стартовая серия из настроек (§2). */
async function placeDefaults(tx: Sql, spaceId: string, settings: BookingSettings, eventTypeKey: string): Promise<{ location: string; format: string }> {
  const series = await latestActiveSeriesOfType(tx, spaceId, eventTypeKey);
  if (series) return { location: series.location, format: series.format === 'online' ? 'online' : 'offline' };
  const seed = settings.seedSeries.find((s) => s.eventTypeKey === eventTypeKey);
  return seed ? { location: seed.location, format: seed.format } : { location: '', format: 'offline' };
}

function sameEventContent(row: EventRow, spaceId: string, e: { eventTypeKey: string; eventDate: string; startTime: string; durationMin: number; capacity: number; location: string; format: string }): boolean {
  return (
    row.spaceId === spaceId &&
    row.seriesId === null &&
    row.eventTypeKey === e.eventTypeKey &&
    row.eventDate === e.eventDate &&
    row.startTime === e.startTime &&
    row.durationMin === e.durationMin &&
    row.capacity === e.capacity &&
    row.location === e.location &&
    row.format === e.format
  );
}

function checkFormat(format: string): void {
  if (!(EVENT_FORMATS as readonly string[]).includes(format)) throw new BadRequestError('format');
}

export const createEvent: CreateEvent = async (deps, viewer, input: EventInput) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  if (!booking.isLocalDate(input.eventDate) || !booking.isLocalTime(input.startTime)) throw new BadRequestError('datetime');
  return inBookingTx({}, async (tx) => {
    const settings = await deps.settings(spaceId, now);
    const type = settings.groupTypes.find((t) => t.key === input.eventTypeKey);
    if (!type) throw new BookingDomainError('invalid_settings');
    const defaults = await placeDefaults(tx, spaceId, settings, type.key);
    const durationMin = input.durationMin ?? type.durationMin;
    const capacity = input.capacity ?? type.capacity;
    const location = input.location ?? defaults.location;
    const format = input.format ?? defaults.format;
    if (!Number.isInteger(durationMin) || durationMin < 1 || durationMin > 1440) throw new BadRequestError('duration');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) throw new BadRequestError('capacity');
    if (location.length > 200) throw new BadRequestError('location');
    checkFormat(format);
    const startsAt = booking.localToEpoch(settings.timeZone, input.eventDate, input.startTime);
    const content = { eventTypeKey: type.key, eventDate: input.eventDate, startTime: input.startTime, durationMin, capacity, location, format };
    const existing = await findEventPlain(tx, input.requestId);
    if (existing) {
      // Повтор запроса: тот же ключ и то же содержимое — прежнее мероприятие.
      if (!sameEventContent(existing, spaceId, content)) throw new BookingDomainError('request_reused');
      return toEventView(existing, await countTaken(tx, existing.id));
    }
    if (startsAt <= now) throw new BookingDomainError('event_in_past');
    const inserted = await insertEvent(tx, { id: input.requestId, spaceId, seriesId: null, ...content, startsAt, occurrenceKey: null, at: now });
    const row = await findEventPlain(tx, input.requestId);
    if (!row || !inserted && !sameEventContent(row, spaceId, content)) throw new BookingDomainError('request_reused');
    if (inserted) await auditEvent(tx, { actor: viewer, action: 'event.create', entity: 'event', entityId: row.id, spaceId, meta: { eventTypeKey: type.key, eventDate: input.eventDate } });
    return toEventView(row, 0);
  });
};

export const updateEvent: UpdateEvent = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  requireSpace(viewer);
  const now = deps.now();
  return inBookingTx({}, async (tx) => {
    const cur = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.manage', lock: true });
    if (!cur) throw eventNotFound();
    if (cur.updatedAt !== input.seenUpdatedAt) throw new ConflictError();
    if (cur.status === 'cancelled') throw new BookingDomainError('event_cancelled');
    const settings = await deps.settings(cur.spaceId, now);
    const p = input.patch;
    const next = {
      eventDate: p.eventDate ?? cur.eventDate,
      startTime: p.startTime ?? cur.startTime,
      durationMin: p.durationMin ?? cur.durationMin,
      capacity: p.capacity ?? cur.capacity,
      location: p.location ?? cur.location,
      format: p.format ?? cur.format,
    };
    if (!booking.isLocalDate(next.eventDate) || !booking.isLocalTime(next.startTime)) throw new BadRequestError('datetime');
    if (!Number.isInteger(next.durationMin) || next.durationMin < 1 || next.durationMin > 1440) throw new BadRequestError('duration');
    if (!Number.isInteger(next.capacity) || next.capacity < 1 || next.capacity > 1000) throw new BadRequestError('capacity');
    if (next.location.length > 200) throw new BadRequestError('location');
    if (p.format !== undefined) checkFormat(p.format);
    // Занято считаем после блокировки мероприятия (D-131): запись, закончившаяся до нас, уже видна.
    const taken = await countTaken(tx, cur.id);
    if (next.capacity < taken) throw new BookingDomainError('capacity_below_taken');
    const moved = next.eventDate !== cur.eventDate || next.startTime !== cur.startTime;
    // D-137: дату и время меняем только у мероприятия без записей; перенос с записями — B3b.
    if (moved && taken > 0) throw new BookingDomainError('event_has_bookings');
    const startsAt = moved ? booking.localToEpoch(settings.timeZone, next.eventDate, next.startTime) : cur.startsAt;
    if (moved && startsAt <= now) throw new BookingDomainError('event_in_past');
    const row = await updateEventRow(viewer, tx, { eventId: cur.id, seenUpdatedAt: input.seenUpdatedAt, next: { ...next, startsAt }, updatedAt: Math.max(now, cur.updatedAt + 1) });
    if (!row) throw eventNotFound();
    await auditEvent(tx, { actor: viewer, action: 'event.update', entity: 'event', entityId: cur.id, spaceId: cur.spaceId, meta: { fields: Object.keys(p).sort() } });
    return toEventView(row, taken);
  });
};

/**
 * Отмена мероприятия каскадом (PROCESS 12.26, §5.4): карточки затронутых клиентов в порядке `id` →
 * мероприятие → записи. Идемпотентна по состоянию: повтор отдаёт `replayed` и ничего не меняет.
 */
export const cancelEvent: CancelEvent = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  requireSpace(viewer);
  const now = deps.now();
  return inBookingTx({}, async (tx): Promise<CancelEventResult> => {
    const probe = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.manage', lock: false });
    if (!probe) throw eventNotFound();

    // 1–2. кого затронем, и сразу блокируем их карточки (раньше мероприятия: порядок D-131)
    const cardIds = await activeCardIdsOfEvent(tx, probe.id);
    const locked = new Map((await lockEventCardsInOrder(tx, probe.spaceId, cardIds)).map((c) => [c.id, c]));

    // 3. мероприятие
    const ev = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.manage', lock: true });
    if (!ev) throw eventNotFound();
    if (ev.status === 'cancelled') return { event: toEventView(ev, await countTaken(tx, ev.id)), cancelledBookings: 0, replayed: true };
    if (ev.startsAt <= now) throw new BookingDomainError('event_in_past');

    // 4. мероприятие отменено: новые записи на него уже невозможны
    const cancelled = await cancelEventRow(viewer, tx, { eventId: ev.id, updatedAt: Math.max(now, ev.updatedAt + 1) });
    if (!cancelled) throw eventNotFound();

    // 5. активные записи; запись, вставленная между шагами 1 и 3, приводит новую карточку — блокируем и её
    const active = await lockActiveBookingsOfEvent(tx, ev.id);
    const extra = [...new Set(active.map((b) => b.cardId))].filter((id) => !locked.has(id)).sort();
    for (const c of await lockEventCardsInOrder(tx, ev.spaceId, extra)) locked.set(c.id, c);

    // 6. отмена записей
    await cancelBookingRows(tx, active.map((b) => b.id), 'event_cancelled', now);

    // 7. события карточек: «Договорились» с этой записью → `booking_cancelled` (причина `client`, 12.26);
    // отказ ядра (`stale`) запись не откатывает, а попадает в историю
    const cardResult = new Map<string, string>();
    for (const b of active) {
      const card = locked.get(b.cardId);
      if (!card) throw new Error('booking: карточка записи не заблокирована при отмене мероприятия');
      if (card.state !== 'agreed') continue;
      const facts = { hasOtherFutureBooking: await hasOtherFutureBooking(tx, { spaceId: b.spaceId, clientId: b.clientId, excludeId: b.id, now }) };
      const rejected = await noteCardEvent(deps, tx, viewer, card, { type: 'booking_cancelled', opId: input.opId, bookingId: b.id, reason: 'client', createdByOpId: null, facts }, now);
      if (rejected) cardResult.set(b.id, rejected);
    }

    // 8. история и лента по каждой записи
    const actorId = actorUserId(viewer);
    for (const b of active) {
      const card = cardResult.get(b.id);
      await insertHistory(tx, {
        bookingId: b.id,
        action: 'event_cancelled',
        from: b.status,
        to: 'cancelled',
        actorId,
        meta: { opId: input.opId, eventId: ev.id, ...(card ? { card } : {}) },
        at: now,
      });
      await insertFeed(tx, {
        clientId: b.clientId,
        spaceId: b.spaceId,
        dealId: b.dealId,
        kind: 'booking.status',
        actorId,
        bookingId: b.id,
        at: now,
        data: { bookingId: b.id, from: b.status, to: 'cancelled', reason: 'event_cancelled' },
      });
    }

    // 9. журнал
    await auditEvent(tx, { actor: viewer, action: 'event.cancel', entity: 'event', entityId: ev.id, spaceId: ev.spaceId, meta: { count: active.length, opId: input.opId } });
    return { event: toEventView(cancelled, await countTaken(tx, ev.id)), cancelledBookings: active.length, replayed: false };
  });
};

export const setEventDuty: SetEventDuty = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  requireSpace(viewer);
  const now = deps.now();
  const userIds = [...new Set(input.userIds)];
  if (userIds.length > MAX_DUTY) throw new BadRequestError('duty_limit');
  return inBookingTx({}, async (tx) => {
    const ev = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.manage', lock: true });
    if (!ev) throw eventNotFound();
    if (ev.status === 'cancelled') throw new BookingDomainError('event_cancelled');
    const valid = await activeMemberIds(tx, ev.spaceId, userIds);
    if (valid.length !== userIds.length) throw new BadRequestError('duty_user');
    await replaceDuty(tx, { eventId: ev.id, userIds, createdBy: actorUserId(viewer), at: now });
    await auditEvent(tx, { actor: viewer, action: 'event.duty', entity: 'event', entityId: ev.id, spaceId: ev.spaceId, meta: { count: userIds.length } });
    return { userIds: await listDutyUserIds(tx, ev.id) };
  });
};

export const listGuests: ListGuests = async (_deps, viewer: Viewer, eventId) => {
  requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const ev = await findEvent(viewer, tx, { eventId, perm: 'booking.read', lock: false });
    if (!ev) throw eventNotFound();
    return listGuestRows(viewer, tx, eventId);
  });
};
