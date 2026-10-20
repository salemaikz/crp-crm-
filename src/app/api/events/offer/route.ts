import { route } from '@/server/access';
import { bookingDeps, offerEvents } from '@/server/domain/booking';
import { OfferQuery, readQuery, respond } from '../../bookings/_lib';

/** Мастер записи: ближайшие мероприятия клиента с местами и текущая запись («перенос с …»). */
export const GET = route({ perm: 'booking.create' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, OfferQuery);
    return offerEvents(bookingDeps(), viewer, { clientId: q.clientId, ...(q.type ? { eventTypeKey: q.type } : {}) });
  }),
);
