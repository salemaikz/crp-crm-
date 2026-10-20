import { route } from '@/server/access';
import { bookingDeps, createBooking, listBookings } from '@/server/domain/booking';
import { BookingsQuery, GroupBookingBody, readJson, readQuery, respond } from './_lib';

/** Список записей по охвату (оператор — свои, РОП — все). */
export const GET = route({ perm: 'booking.read' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, BookingsQuery);
    return listBookings(viewer, { from: q.from, to: q.to, ...(q.status ? { status: q.status } : {}), ...(q.eventId ? { eventId: q.eventId } : {}), ...(q.clientId ? { clientId: q.clientId } : {}) });
  }),
);

/** Записать клиента на мероприятие или перенести (повторная запись того же вида). 201; повтор ключа — 200. */
export const POST = route({ perm: 'booking.create' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, GroupBookingBody);
    const result = await createBooking(bookingDeps(), viewer, body);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
