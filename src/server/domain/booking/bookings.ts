// Групповые записи: создать, перенести, подтвердить, явка, отменить (docs/booking-design.md §5.1–5.3, §7).
// Порядок блокировок: карточка → мероприятие → записи (D-131). Карточку модуль не пишет: последствия
// статусов — события машины обзвона через CardPort (D-133); сделку обеспечивает DealLink (D-134).
import { booking } from '@crm/core';
import { BadRequestError, ConflictError, NotFoundError, scopeOf, type Viewer } from '@/server/access';
import { throwNotFoundOrConflict } from '@/server/access/scope';
import { isUniqueViolation, newId, type Sql } from '@/server/platform/db';
import { noteCardEvent } from './cardEvents';
import { BookingDomainError } from './errors';
import { nearestOptions } from './events';
import { requireRole, requireSpace } from './guards';
import {
  actorUserId,
  contactBelongsToClient,
  countTaken,
  findBooking,
  findBookingByRequestId,
  findCardByClient,
  findEvent,
  findHistoryBookingId,
  hasOtherFutureBooking,
  insertFeed,
  insertGroupBooking,
  insertHistory,
  lastNoShowAt,
  listBookingRows,
  lockCardOfBooking,
  lockClientBookings,
  markMoved,
  spaceOfEvent,
  toBookingView,
  toClientBookingLite,
  toEventLite,
  updateStatus,
  type BookingRow,
} from './repo';
import { inBookingTx } from './tx';
import type {
  BookingActionBase,
  BookingActor,
  BookingCancelReason,
  BookingDeps,
  BookingVia,
  BookingView,
  CancelBooking,
  CreateBooking,
  CreateBookingResult,
  GetBooking,
  ListBookings,
  LockedCard,
  MarkAttendance,
  MoveBooking,
  SetConfirmation,
} from './types';

const LIST_LIMIT = 200;
/** Новая запись и перенос возможны только для карточки в этих состояниях (D-133). */
const BOOKABLE_CARD_STATES: readonly string[] = ['agreed', 'client'];

const bookingNotFound = () => new BookingDomainError('booking_not_found');

// ---------------------------------------------------------------------------
// Создать и перенести
// ---------------------------------------------------------------------------

interface PlaceArgs {
  requestId: string;
  clientId: string;
  eventId: string;
  contactId: string | null;
  via: BookingVia;
  importKey: string | null;
  /** undefined — автор сам исполнитель; null — автор неизвестен (импорт без оператора). */
  bookedBy: string | null | undefined;
  /** Итог «Договорились» (C5) и импорт сами отвечают за состояние карточки. */
  skipStateCheck: boolean;
  /** C5 уже заблокировал карточку в своей транзакции. */
  lockCard: boolean;
  /** Явный перенос конкретной записи (`/move`). */
  forced: { bookingId: string; version: number } | null;
}

function replayResult(prior: BookingRow): CreateBookingResult {
  const view = toBookingView(prior);
  return prior.movedFromId ? { action: 'moved', booking: view, movedFromId: prior.movedFromId, replayed: true } : { action: 'created', booking: view, replayed: true };
}

async function placeInTx(deps: BookingDeps, actor: BookingActor, tx: Sql, now: number, a: PlaceArgs): Promise<CreateBookingResult> {
  const perm = 'booking.create';
  let spaceId: string;
  if (actor.kind === 'user') {
    requireRole(actor, perm, 'object');
    spaceId = requireSpace(actor);
  } else {
    const found = await spaceOfEvent(tx, a.eventId);
    if (!found) throw new BookingDomainError('event_not_found');
    spaceId = found;
  }

  // 1. карточка = блокировка клиента в пространстве (PROCESS 12.18); не видна — клиента «нет»
  const card = await findCardByClient(actor, tx, { spaceId, clientId: a.clientId, perm, lock: a.lockCard });
  if (!card) throw new NotFoundError();

  // 2. повтор ключа: после блокировки параллельный дубль видит первую вставку
  const prior = await findBookingByRequestId(tx, a.requestId);
  if (prior) {
    if (prior.clientId === a.clientId && prior.eventId === a.eventId) return replayResult(prior);
    throw new BookingDomainError('request_reused');
  }

  // 3. состояние карточки: запись возможна только после «Договорились» (D-133)
  if (!a.skipStateCheck && !BOOKABLE_CARD_STATES.includes(card.state)) throw new BookingDomainError('outcome_required');

  // 4. контакт «кто придёт» — клиента
  if (a.contactId !== null && !(await contactBelongsToClient(tx, a.contactId, a.clientId))) throw new BadRequestError('contact');

  // 5. мероприятие
  const settings = await deps.settings(spaceId, now);
  const ev = await findEvent(actor, tx, { eventId: a.eventId, perm: 'booking.read', lock: true });
  // Мероприятие другого пространства для записи не существует (и системному исполнителю тоже)
  if (!ev || ev.spaceId !== spaceId) throw new BookingDomainError('event_not_found');
  if (!settings.groupTypes.some((t) => t.key === ev.eventTypeKey)) throw new BookingDomainError('invalid_settings');

  // 6. записи клиента: «новая или перенос» (D-042)
  const existing = await lockClientBookings(actor, tx, { spaceId, clientId: a.clientId, perm });
  let from: BookingRow | null = null;
  if (a.forced) {
    const old = await findBooking(actor, tx, { id: a.forced.bookingId, perm, lock: true });
    if (!old || old.clientId !== a.clientId) throw bookingNotFound();
    if (old.version !== a.forced.version) throw new ConflictError();
    if (old.eventId === ev.id) throw new BookingDomainError('already_registered');
    const check = booking.checkTransition(old.status, 'moved', { tz: settings.timeZone, now, startsAt: old.startsAt, durationMin: old.durationMin });
    if (!check.ok) throw new BookingDomainError(check.reason);
    if (existing.some((b) => b.eventId === ev.id)) throw new BookingDomainError('already_registered');
    from = old;
  } else {
    const decision = booking.resolveRepeatBooking(existing.map(toClientBookingLite), { eventTypeKey: ev.eventTypeKey, eventId: ev.id }, now);
    if (decision.action === 'reject') throw new BookingDomainError('already_registered');
    if (decision.action === 'move') from = existing.find((b) => b.id === decision.fromBookingId) ?? null;
  }

  // 7. места: занято считаем отдельным запросом ПОСЛЕ блокировки мероприятия (D-131)
  const taken = await countTaken(tx, ev.id);
  // Импорт заносит и прошедшие мероприятия: «уже началось» ему не помеха.
  const lite = a.via === 'import' ? { ...toEventLite(ev), startsAt: Number.MAX_SAFE_INTEGER } : toEventLite(ev);
  const bookable = booking.eventBookability(lite, taken, now);
  if (!bookable.ok) {
    if (bookable.reason === 'event_full') {
      throw new BookingDomainError('event_full', await nearestOptions(actor, tx, { spaceId, settings, eventTypeKey: ev.eventTypeKey, now }));
    }
    throw new BookingDomainError(bookable.reason);
  }

  // 8. сделка: перенос сохраняет сделку исходной записи (D-134)
  const dealId = from ? from.dealId : await deps.deals.ensureOpen(tx, actor, card, { requestId: a.requestId, at: now, stages: settings.deals });

  // 9. вставка; заслуга при переносе остаётся от исходной записи (PROCESS 5.6)
  const bookedBy = from ? from.bookedByUserId : a.bookedBy === undefined ? actorUserId(actor) : a.bookedBy;
  const id = newId();
  let row: BookingRow | null;
  try {
    row = await insertGroupBooking(tx, {
      id,
      spaceId,
      event: ev,
      clientId: a.clientId,
      cardId: card.id,
      dealId,
      contactId: from ? from.contactId : a.contactId,
      via: a.via,
      bookedByUserId: bookedBy,
      responsibleUserId: card.ownerUserId,
      movedFromId: from?.id ?? null,
      requestId: a.requestId,
      importKey: a.importKey,
      at: now,
    });
  } catch (e) {
    // Индексы bookings_group_uq и bookings_import_uq — второй рубеж: под блокировками сюда не дойдём.
    if (isUniqueViolation(e)) throw new BookingDomainError('already_registered');
    throw e;
  }
  if (!row) {
    const again = await findBookingByRequestId(tx, a.requestId);
    if (again && again.clientId === a.clientId && again.eventId === a.eventId) return replayResult(again);
    throw new BookingDomainError('request_reused');
  }

  // 10. история и лента
  const actorId = actorUserId(actor);
  if (from) {
    const moved = await markMoved(actor, tx, { id: from.id, version: from.version, toId: row.id, at: now });
    if (!moved) await throwNotFoundOrConflict(actor, tx, 'booking', from.id);
    await insertHistory(tx, { bookingId: from.id, action: 'moved', from: from.status, to: 'moved', actorId, meta: { toId: row.id, requestId: a.requestId }, at: now });
    await insertHistory(tx, { bookingId: row.id, action: 'created', from: '', to: 'registered', actorId, meta: { fromId: from.id, requestId: a.requestId, via: a.via }, at: now });
    await insertFeed(tx, {
      clientId: a.clientId,
      spaceId,
      dealId,
      kind: 'booking.moved',
      actorId,
      bookingId: row.id,
      at: now,
      data: { fromId: from.id, toId: row.id, fromEventId: from.eventId, toEventId: ev.id },
    });
    return { action: 'moved', booking: toBookingView(row), movedFromId: from.id, replayed: false };
  }
  await insertHistory(tx, { bookingId: row.id, action: 'created', from: '', to: 'registered', actorId, meta: { requestId: a.requestId, via: a.via }, at: now });
  await insertFeed(tx, {
    clientId: a.clientId,
    spaceId,
    dealId,
    kind: 'booking.created',
    actorId,
    bookingId: row.id,
    at: now,
    data: { bookingId: row.id, eventId: ev.id, eventTypeKey: ev.eventTypeKey, eventDate: ev.eventDate, startTime: ev.startTime, via: a.via },
  });
  return { action: 'created', booking: toBookingView(row), replayed: false };
}

export const createBooking: CreateBooking = async (deps, actor, req, opts = {}) => {
  // Консультации и «серые» заявки — B3a/B5: сюда они попасть не должны (ошибка сборки, не ответ пользователю).
  if (req.kind !== 'group') throw new Error('B3a: индивидуальная запись ещё не реализована');
  const now = deps.now();
  const args: PlaceArgs = {
    requestId: req.requestId,
    clientId: req.clientId,
    eventId: req.eventId,
    contactId: req.contactId,
    via: opts.imported ? 'import' : 'ui',
    importKey: opts.imported?.importKey ?? null,
    bookedBy: opts.imported ? opts.imported.bookedByUserId : undefined,
    skipStateCheck: opts.fromOutcome !== undefined || opts.imported !== undefined,
    lockCard: opts.fromOutcome === undefined,
    forced: null,
  };
  return inBookingTx(opts, (tx) => placeInTx(deps, actor, tx, now, args));
};

export const moveBooking: MoveBooking = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.create', 'object');
  requireSpace(viewer);
  const now = deps.now();
  return inBookingTx({}, async (tx) => {
    const old = await findBooking(viewer, tx, { id: input.bookingId, perm: 'booking.create', lock: false });
    if (!old) throw bookingNotFound();
    return placeInTx(deps, viewer, tx, now, {
      requestId: input.requestId,
      clientId: old.clientId,
      eventId: input.eventId,
      contactId: old.contactId,
      via: 'ui',
      importKey: null,
      bookedBy: undefined,
      skipStateCheck: false,
      lockCard: true,
      forced: { bookingId: input.bookingId, version: input.version },
    });
  });
};

// ---------------------------------------------------------------------------
// Статусы: подтверждение, явка, отмена
// ---------------------------------------------------------------------------

interface StatusSpec extends BookingActionBase {
  perm: 'booking.create' | 'booking.attend';
  to: booking.BookingStatus;
  reason: 'client' | 'operator_error' | null;
  /** Из каких статусов действие вообще возможно (автомат шире: «передумал» — не через этот API, D-133). */
  allowedFrom?: readonly booking.BookingStatus[];
}

/**
 * Общий путь трёх ручных действий (§5.3): запись → карточка `FOR UPDATE` → запись `FOR UPDATE` → повтор
 * `opId` → версия → автомат статусов → UPDATE → событие карточки (§7.1) → история и лента.
 */
async function changeStatus(deps: BookingDeps, viewer: Viewer, spec: StatusSpec): Promise<BookingView> {
  if (spec.perm === 'booking.create') requireRole(viewer, 'booking.create', 'object');
  requireSpace(viewer);
  const now = deps.now();
  return inBookingTx({}, async (tx) => {
    const probe = await findBooking(viewer, tx, { id: spec.bookingId, perm: spec.perm, lock: false });
    if (!probe) throw bookingNotFound();
    const settings = await deps.settings(probe.spaceId, now);
    const card = await lockCardOfBooking(tx, probe.cardId);
    if (!card) throw new Error('booking: у записи нет карточки');
    const b = await findBooking(viewer, tx, { id: spec.bookingId, perm: spec.perm, lock: true });
    if (!b) throw bookingNotFound();

    // повтор того же действия: ничего не меняем и не шлём событий (D-132)
    const seenOn = await findHistoryBookingId(tx, spec.opId);
    if (seenOn !== null) {
      if (seenOn !== b.id) throw new BookingDomainError('request_reused');
      return toBookingView(b);
    }
    if (b.version !== spec.version) throw new ConflictError();
    if (spec.allowedFrom && !spec.allowedFrom.includes(b.status)) throw new BookingDomainError('invalid_transition');

    const check = booking.checkTransition(b.status, spec.to, {
      tz: settings.timeZone,
      now,
      startsAt: b.startsAt,
      durationMin: b.durationMin,
      lateCorrection: scopeOf(viewer, 'booking.manage') !== null,
    });
    if (!check.ok) throw new BookingDomainError(check.reason);
    // «Ошибка оператора» — только автор и только в первые минуты (PROCESS 12.7)
    if (spec.reason === 'operator_error' && !(b.bookedByUserId === viewer.userId && now - b.createdAt <= settings.operatorErrorWindowMin * 60_000)) {
      throw new BookingDomainError('too_late');
    }

    const cancelReason: BookingCancelReason = spec.to === 'cancelled' ? (spec.reason ?? '') : '';
    const updated = await updateStatus(viewer, tx, { id: b.id, version: b.version, to: spec.to, cancelReason, perm: spec.perm, at: now });
    if (!updated) await throwNotFoundOrConflict(viewer, tx, 'booking', b.id);
    const row = updated as BookingRow;

    const cardCode = await emitCardEvent(deps, tx, viewer, { card, before: b, after: row, spec, settingsDeals: settings.deals, now });

    await insertHistory(tx, {
      id: spec.opId,
      bookingId: b.id,
      action: spec.to === 'cancelled' ? 'cancelled' : 'status',
      from: b.status,
      to: spec.to,
      actorId: viewer.userId,
      meta: { opId: spec.opId, ...(spec.reason ? { reason: spec.reason } : {}), ...(cardCode ? { card: cardCode } : {}) },
      at: now,
    });
    await insertFeed(tx, {
      clientId: b.clientId,
      spaceId: b.spaceId,
      dealId: b.dealId,
      kind: 'booking.status',
      actorId: viewer.userId,
      bookingId: b.id,
      at: now,
      data: { bookingId: b.id, from: b.status, to: spec.to, reason: spec.reason ?? '' },
    });
    return toBookingView(row);
  });
}

/** Событие карточки по таблице §7.1; возвращает код отказа ядра (для истории) или null. */
async function emitCardEvent(
  deps: BookingDeps,
  tx: Sql,
  viewer: Viewer,
  c: { card: LockedCard; before: BookingRow; after: BookingRow; spec: StatusSpec; settingsDeals: Awaited<ReturnType<BookingDeps['settings']>>['deals']; now: number },
): Promise<string | null> {
  const { card, before, spec, now } = c;
  const facts = async () => ({ otherFuture: await hasOtherFutureBooking(tx, { spaceId: before.spaceId, clientId: before.clientId, excludeId: before.id, now }) });

  if (spec.to === 'no_show' && card.state === 'agreed') {
    const f = await facts();
    return noteCardEvent(deps, tx, viewer, card, { type: 'no_show', opId: spec.opId, bookingId: before.id, facts: { hasOtherFutureBooking: f.otherFuture } }, now);
  }
  if (spec.to === 'attended') {
    if (card.state === 'agreed') {
      const f = await facts();
      return noteCardEvent(deps, tx, viewer, card, { type: 'attended', opId: spec.opId, bookingId: before.id, eventDay: before.bookingDate, facts: { hasNextFutureBooking: f.otherFuture } }, now);
    }
    if (before.status === 'no_show' && card.state === 'callback') {
      const f = await facts();
      const markedAt = (await lastNoShowAt(tx, before.id)) ?? before.updatedAt;
      return noteCardEvent(deps, tx, viewer, card, { type: 'attendance_corrected', opId: spec.opId, bookingId: before.id, noShowMarkedAt: markedAt, facts: { hasNextFutureBooking: f.otherFuture } }, now);
    }
    // Клиент и прочие состояния: машина карточки не нужна, этап сделки двигаем напрямую (только вперёд)
    if (before.dealId) await deps.deals.advanceOnAttended(tx, viewer, { dealId: before.dealId, bookingId: before.id, at: now, stages: c.settingsDeals });
    return null;
  }
  if (spec.to === 'cancelled' && spec.reason && card.state === 'agreed') {
    const f = await facts();
    return noteCardEvent(
      deps,
      tx,
      viewer,
      card,
      { type: 'booking_cancelled', opId: spec.opId, bookingId: before.id, reason: spec.reason, createdByOpId: before.requestId, facts: { hasOtherFutureBooking: f.otherFuture } },
      now,
    );
  }
  return null;
}

export const setConfirmation: SetConfirmation = (deps, viewer, input) =>
  changeStatus(deps, viewer, { perm: 'booking.create', bookingId: input.bookingId, opId: input.opId, version: input.version, to: input.to, reason: null, allowedFrom: booking.ACTIVE_STATUSES });

export const markAttendance: MarkAttendance = (deps, viewer, input) =>
  changeStatus(deps, viewer, { perm: 'booking.attend', bookingId: input.bookingId, opId: input.opId, version: input.version, to: input.to, reason: null });

export const cancelBooking: CancelBooking = (deps, viewer, input) =>
  changeStatus(deps, viewer, { perm: 'booking.create', bookingId: input.bookingId, opId: input.opId, version: input.version, to: 'cancelled', reason: input.reason });

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

export const getBooking: GetBooking = async (viewer, bookingId) => {
  requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const row = await findBooking(viewer, tx, { id: bookingId, perm: 'booking.read', lock: false });
    if (!row) throw bookingNotFound();
    return toBookingView(row);
  });
};

export const listBookings: ListBookings = async (viewer, filter) => {
  const spaceId = requireSpace(viewer);
  if (!booking.isLocalDate(filter.from) || !booking.isLocalDate(filter.to) || filter.from > filter.to) throw new BadRequestError('window');
  const limit = Math.min(Math.max(filter.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const rows = await inBookingTx({}, (tx) =>
    listBookingRows(viewer, tx, {
      spaceId,
      from: filter.from,
      to: filter.to,
      statuses: filter.status && filter.status.length > 0 ? filter.status : null,
      eventId: filter.eventId ?? null,
      clientId: filter.clientId ?? null,
      limit,
    }),
  );
  return rows.map(toBookingView);
};
