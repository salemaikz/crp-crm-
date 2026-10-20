// Назначение и переназначение консультанта (B5b, docs/deals-handoffs-design.md §4.7).
// Порядок блокировок: запись (охват booking.manage) → карточка → день → запись FOR UPDATE (D-251).
// С флагом BK_WIZARD консультант обязан быть в ранге `rankAssignCandidates` на это время; без него — только активен
// в пространстве (ручное назначение работает без флага, D-203).
import { booking as core } from '@crm/core';
import { ConflictError } from '@/server/access';
import { throwNotFoundOrConflict } from '@/server/access/scope';
import { closeAutoTaskByKey } from '@/server/domain/tasks/auto';
import { isFeatureEnabled } from '@/server/platform/flags';
import { loadDay, lockConsultDay, toSuggested } from './consultDay';
import type { AssignConsultant, ListAssignCandidates, SuggestedConsultant } from './consultTypes';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import { greyTaskKey, notifyConsultantAssigned, notifyConsultNew, promoteReserve } from './reserve';
import { findBooking, findHistoryBookingId, insertFeed, insertHistory, listResourceRows, lockCardOfBooking, toBookingView } from './repo';
import { assignBookingRow } from './repo.consult';
import { inBookingTx } from './tx';

const notFound = () => new BookingDomainError('booking_not_found');

/** Подсказка: направление кандидата совпадает с направлением записи. */
const matches = (directions: readonly string[], key: string): boolean => key !== '' && directions.includes(key);

export const assignConsultant: AssignConsultant = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'object');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  return inBookingTx({}, async (tx) => {
    const probe = await findBooking(viewer, tx, { id: input.bookingId, perm: 'booking.manage', lock: false });
    if (!probe) throw notFound();
    if (probe.kind !== 'individual') throw new BookingDomainError('not_an_individual_event');
    const card = await lockCardOfBooking(tx, probe.cardId);
    if (!card) throw new Error('booking: у записи нет карточки');
    await lockConsultDay(tx, spaceId, probe.bookingDate);
    const b = await findBooking(viewer, tx, { id: input.bookingId, perm: 'booking.manage', lock: true });
    if (!b) throw notFound();

    // повтор того же действия: ничего не меняем и не шлём (D-132)
    const seenOn = await findHistoryBookingId(tx, input.opId);
    if (seenOn !== null) {
      if (seenOn !== b.id) throw new BookingDomainError('request_reused');
      return toBookingView(b);
    }
    if (b.version !== input.version) throw new ConflictError();
    if (!core.isActive(b.status)) throw new BookingDomainError('invalid_transition');
    if (b.startsAt <= now) throw new BookingDomainError('slot_in_past');

    const flag = isFeatureEnabled('BK_WIZARD');
    const { snapshot, resources } = await loadDay(tx, spaceId, b.bookingDate, settings);
    const res = resources.find((r) => r.id === input.resourceId);
    if (!res) throw new BookingDomainError('consultant_not_found');
    if (!res.active) throw new BookingDomainError('consultant_inactive');
    if (flag) {
      const ranked = core.rankAssignCandidates(snapshot, { id: b.id, startTime: b.startTime, durationMin: b.durationMin }, b.directionKey);
      if (!ranked.some((r) => r.consultantId === res.id)) throw new BookingDomainError('slot_taken', undefined, ranked.slice(0, 3).map(toSuggested));
    }
    // Тот же консультант — ничего не меняем
    if (b.resourceId === res.id && !b.isReserve) return toBookingView(b);

    const durationMin = res.usesSchedule ? res.slotMin : b.durationMin;
    const row = await assignBookingRow(viewer, tx, { id: b.id, version: b.version, resourceId: res.id, durationMin, at: now });
    if (!row) await throwNotFoundOrConflict(viewer, tx, 'booking', b.id);
    const updated = row as NonNullable<typeof row>;
    await insertHistory(tx, {
      id: input.opId,
      bookingId: b.id,
      action: 'assigned',
      from: b.status,
      to: b.status,
      actorId: viewer.userId,
      meta: { opId: input.opId, resourceId: res.id, from: b.resourceId ?? '' },
      at: now,
    });
    await insertFeed(tx, {
      clientId: b.clientId,
      spaceId,
      dealId: b.dealId,
      kind: 'booking.assigned',
      actorId: viewer.userId,
      bookingId: b.id,
      at: now,
      data: { bookingId: b.id, resourceId: res.id },
    });
    await closeAutoTaskByKey(tx, viewer, { sourceKey: greyTaskKey(b.id), at: now });
    await notifyConsultNew(tx, { bookingId: b.id, resourceId: res.id, exceptUserId: viewer.userId, at: now });
    await notifyConsultantAssigned(tx, { bookingId: b.id, resourceId: res.id, authorUserId: b.bookedByUserId, exceptUserId: viewer.userId, at: now });
    // Был другой консультант: его слот освободился (даты уже заблокированы)
    if (b.resourceId && b.resourceId !== res.id) {
      await promoteReserve(tx, viewer, { spaceId, resourceId: b.resourceId, date: b.bookingDate, startTime: b.startTime, durationMin: b.durationMin, at: now });
    }
    return toBookingView(updated);
  });
};

export const listAssignCandidates: ListAssignCandidates = async (deps, viewer, bookingId) => {
  requireRole(viewer, 'booking.manage', 'object');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  return inBookingTx({}, async (tx): Promise<SuggestedConsultant[]> => {
    const b = await findBooking(viewer, tx, { id: bookingId, perm: 'booking.manage', lock: false });
    if (!b) throw notFound();
    if (b.kind !== 'individual') throw new BookingDomainError('not_an_individual_event');
    if (isFeatureEnabled('BK_WIZARD')) {
      const { snapshot } = await loadDay(tx, spaceId, b.bookingDate, settings);
      return core.rankAssignCandidates(snapshot, { id: b.id, startTime: b.startTime, durationMin: b.durationMin }, b.directionKey).map(toSuggested);
    }
    // Без флага снимка нет: все активные консультанты, совпадение направления первым
    const list = await listResourceRows(tx, { spaceId, includeInactive: false });
    return list
      .map((r) => ({ r, match: matches(r.directions, b.directionKey) }))
      .sort((x, y) => Number(y.match) - Number(x.match) || x.r.sort - y.r.sort || x.r.name.localeCompare(y.r.name, 'ru'))
      .map((x) => ({ resourceId: x.r.id, name: x.r.name, directionMatch: x.match, reserve: false }));
  });
};
