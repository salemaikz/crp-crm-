import { route } from '@/server/access';
import { bookingDeps, createEvent, listEvents } from '@/server/domain/booking';
import { EventBody, EventsQuery, readJson, readQuery, respond } from '../bookings/_lib';

export const GET = route({ perm: 'booking.read' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, EventsQuery);
    return listEvents(bookingDeps(), viewer, { from: q.from, to: q.to, ...(q.type ? { eventTypeKey: q.type } : {}), includeCancelled: q.cancelled === '1' });
  }),
);

/** Разовое мероприятие (РОП). Повтор ключа возвращает прежнее. */
export const POST = route({ perm: 'booking.manage' }, ({ req, viewer }) =>
  respond(async () => createEvent(bookingDeps(), viewer, await readJson(req, EventBody))),
);
