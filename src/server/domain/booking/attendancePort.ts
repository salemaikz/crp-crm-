// Порт явки для № 33 (pipeline-v2 §4.1, контракт B1 ↔ C6): явка внутри транзакции вызывающего, без события карточки.
// Карточку блокирует и ведёт вызывающий (C6): здесь запись, история, лента с автором и пересчёт кэша признаков.
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { bookingDeps } from './deps';
import { changeStatusTx } from './bookings';
import { BookingDomainError } from './errors';
import { requireSpace } from './guards';
import { findBooking, isOpenDealOfCard } from './repo';
import type { AttendanceInTxInput, AttendanceInTxResult, BookingDeps, BookingPort } from './types';

const notFound = () => new BookingDomainError('booking_not_found');

export async function setAttendanceInTx(deps: BookingDeps, tx: Sql, viewer: Viewer, input: AttendanceInTxInput): Promise<AttendanceInTxResult> {
  requireSpace(viewer);
  // Чужое = несуществующее: вне охвата чтения, чужая карточка и запись не из открытой сделки отвечают одинаково
  const probe = await findBooking(viewer, tx, { id: input.bookingId, perm: 'booking.read', lock: false });
  if (!probe) throw notFound();
  if (input.cardId !== undefined && probe.cardId !== input.cardId) throw notFound();
  if (!probe.dealId || !(await isOpenDealOfCard(tx, { dealId: probe.dealId, cardId: probe.cardId }))) throw notFound();
  // Читать вправе, отмечать — нет: 403, а не 404 (запись уже показана оператору в карточке)
  if (!(await findBooking(viewer, tx, { id: input.bookingId, perm: 'booking.attend', lock: false }))) throw new BookingDomainError('attendance_forbidden');
  const r = await changeStatusTx(
    deps,
    viewer,
    { perm: 'booking.attend', bookingId: input.bookingId, opId: input.opId, version: 0, to: input.to, reason: null, cardEvent: 'suppress', portMode: true },
    { tx },
  );
  return { changed: r.changed, status: r.view.status, eventKind: r.before.kind, startedAt: r.before.startsAt };
}

/** Порт с зависимостями записи по умолчанию. */
export const bookingPort: BookingPort = {
  setAttendanceInTx: (tx, viewer, input) => setAttendanceInTx(bookingDeps(), tx, viewer, input),
};
