// Дежурство на групповом мероприятии: экран «Дежурство», «Остальные не пришли», кандидаты в дежурные
// (docs/deals-handoffs-design.md §2.5, §2.8; D-242, D-072). Явку одной записи ставит `markAttendance` (bookings.ts).
// Порядок блокировок: карточки в порядке id → мероприятие → записи (D-131, D-251).
import { booking } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import { closeAutoTaskByKey } from '@/server/domain/tasks/auto';
import { newId } from '@/server/platform/db';
import { noteCardEvent } from './cardEvents';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import type { DutyCandidates, DutyEventView, GetDutyCandidates, ListDutyEvents, MarkRestNoShow, NoShowRestResult } from './dutyTypes';
import {
  actorUserId,
  attendanceMarkKeys,
  cardIdsOfRestBookings,
  findEvent,
  hasOtherFutureBooking,
  insertFeed,
  insertHistory,
  listDutyCandidateRows,
  listDutyEventRows,
  listDutyNameRows,
  listEventRows,
  listDutyUserIds,
  lockEventCardsInOrder,
  lockRestBookings,
  toEventView,
  updateStatus,
  type DutyEventRow,
} from './repo';
import { inBookingTx } from './tx';
import type { BookingDeps, EventView } from './types';

const MAX_REST = 1000;

const eventNotFound = () => new BookingDomainError('event_not_found');

function toDutyView(r: DutyEventRow, now: number): DutyEventView {
  return {
    ...toEventView(r, r.taken),
    iAmDuty: r.iAmDuty,
    started: now >= r.startsAt,
    counts: { unmarked: r.unmarked, attended: r.attended, noShow: r.noShow },
  };
}

/** Границы местных суток `now`: [начало сегодня, начало завтра). */
async function todayBounds(deps: BookingDeps, spaceId: string, now: number): Promise<{ dayStart: number; dayEnd: number }> {
  const settings = await deps.settings(spaceId, now);
  const today = booking.epochToLocalDate(settings.timeZone, now);
  return {
    dayStart: booking.localToEpoch(settings.timeZone, today, '00:00'),
    dayEnd: booking.localToEpoch(settings.timeZone, booking.addDays(today, 1), '00:00'),
  };
}

/**
 * Сегодняшние мероприятия, где зритель отмечает явку по booking.attend: охват team/space/all — по охвату роли,
 * дежурство (`duty_today`) — своё (D-317). Чужих и завтрашних нет.
 */
export const listDutyEvents: ListDutyEvents = async (deps, viewer) => {
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const bounds = await todayBounds(deps, spaceId, now);
  const rows = await inBookingTx({}, (tx) =>
    listDutyEventRows(viewer, tx, { spaceId, me: viewer.userId, ...bounds }),
  );
  return rows.map((r) => toDutyView(r, now));
};

/** Одно сегодняшнее мероприятие дежурства; без booking.attend на нём (D-317) — как несуществующее. */
export async function getDutyEvent(deps: BookingDeps, viewer: Viewer, eventId: string): Promise<DutyEventView> {
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const bounds = await todayBounds(deps, spaceId, now);
  const rows = await inBookingTx({}, (tx) =>
    listDutyEventRows(viewer, tx, { spaceId, me: viewer.userId, ...bounds, eventId }),
  );
  const row = rows[0];
  if (!row) throw eventNotFound();
  return toDutyView(row, now);
}

/**
 * «Остальные не пришли» (D-242): «Не пришёл» только тем из присланных, кто сейчас без отметки. Запись, которую
 * успели отметить «Пришёл» между загрузкой экрана и нажатием, не тронута. Одна транзакция на мероприятие.
 */
export const markRestNoShow: MarkRestNoShow = async (deps, viewer, input) => {
  requireSpace(viewer);
  const ids = [...new Set(input.bookingIds)];
  if (ids.length === 0 || ids.length > MAX_REST) throw new BadRequestError('booking_ids');
  const now = deps.now();
  return inBookingTx({}, async (tx): Promise<NoShowRestResult> => {
    // 0. мероприятие видно по booking.attend, иначе 404
    const probe = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.attend', lock: false });
    if (!probe) throw eventNotFound();
    if (probe.status === 'cancelled') throw new BookingDomainError('event_cancelled');
    if (now < probe.startsAt) throw new BookingDomainError('too_early');
    const settings = await deps.settings(probe.spaceId, now);

    // 1–2. карточки затронутых записей — без охвата карточки: дежурному она не видна (D-072)
    const cardIds = await cardIdsOfRestBookings(viewer, tx, { eventId: probe.id, bookingIds: ids });
    const cards = new Map((await lockEventCardsInOrder(tx, probe.spaceId, cardIds)).map((c) => [c.id, c]));

    // 3. мероприятие, затем 4. записи — состояние читается уже после блокировок
    const ev = await findEvent(viewer, tx, { eventId: input.eventId, perm: 'booking.attend', lock: true });
    if (!ev) throw eventNotFound();
    if (ev.status === 'cancelled') throw new BookingDomainError('event_cancelled');
    const rows = await lockRestBookings(viewer, tx, { eventId: ev.id, bookingIds: ids });

    // 5. на каждую запись: статус, история, лента, событие карточки, закрытие «Отметьте явку»
    let marked = 0;
    const actorId = actorUserId(viewer);
    for (const b of rows) {
      const card = cards.get(b.cardId);
      // Запись, появившаяся с карточкой не из шага 2, уходит в skipped: блокировку не берём вне порядка
      if (!card) continue;
      const check = booking.checkTransition(b.status, 'no_show', { tz: settings.timeZone, now, startsAt: b.startsAt, durationMin: b.durationMin, lateCorrection: false });
      if (!check.ok) continue;
      const updated = await updateStatus(viewer, tx, { id: b.id, version: b.version, to: 'no_show', cancelReason: '', perm: 'booking.attend', at: now });
      if (!updated) continue;
      marked += 1;
      let cardCode: string | null = null;
      if (card.state === 'agreed') {
        const other = await hasOtherFutureBooking(tx, { spaceId: b.spaceId, clientId: b.clientId, excludeId: b.id, now });
        cardCode = await noteCardEvent(deps, tx, viewer, card, { type: 'no_show', opId: newId(), bookingId: b.id, facts: { hasOtherFutureBooking: other } }, now);
      }
      await insertHistory(tx, {
        bookingId: b.id,
        action: 'status',
        from: b.status,
        to: 'no_show',
        actorId,
        meta: { opId: input.opId, bulk: true, ...(cardCode ? { card: cardCode } : {}) },
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
        data: { bookingId: b.id, from: b.status, to: 'no_show', reason: 'bulk' },
      });
      for (const sourceKey of attendanceMarkKeys(b.id)) await closeAutoTaskByKey(tx, viewer, { sourceKey, at: now });
    }
    return { marked, skipped: ids.length - marked };
  });
};

/** Дежурные мероприятия и кого можно назначить (РОП, `booking.manage`). */
export const getDutyCandidates: GetDutyCandidates = async (_deps, viewer, eventId): Promise<DutyCandidates> => {
  requireRole(viewer, 'booking.manage', 'object');
  requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const ev = await findEvent(viewer, tx, { eventId, perm: 'booking.manage', lock: false });
    if (!ev) throw eventNotFound();
    return { userIds: await listDutyUserIds(tx, ev.id), candidates: await listDutyCandidateRows(tx, ev.spaceId) };
  });
};

/** Мероприятие страницы РОП: места, дежурные поимённо. */
export interface EventBoardItem extends EventView {
  duty: { userId: string; name: string }[];
}

export interface EventsBoard {
  events: EventBoardItem[];
  /** Кого можно назначить дежурным: активные сотрудники пространства. */
  candidates: { userId: string; name: string }[];
}

/** Страница «Мероприятия» РОП: ближайшие мероприятия с дежурными и список сотрудников одним чтением. */
export async function listEventsBoard(_deps: BookingDeps, viewer: Viewer, window: { from: string; to: string }): Promise<EventsBoard> {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  return inBookingTx({}, async (tx) => {
    const rows = await listEventRows(viewer, tx, { spaceId, from: window.from, to: window.to, eventTypeKey: null, includeCancelled: false });
    const duty = await listDutyNameRows(tx, rows.map((r) => r.id));
    const byEvent = new Map<string, { userId: string; name: string }[]>();
    for (const d of duty) byEvent.set(d.eventId, [...(byEvent.get(d.eventId) ?? []), { userId: d.userId, name: d.name }]);
    return {
      events: rows.map((r) => ({ ...toEventView(r, r.taken), duty: byEvent.get(r.id) ?? [] })),
      candidates: await listDutyCandidateRows(tx, spaceId),
    };
  });
}
