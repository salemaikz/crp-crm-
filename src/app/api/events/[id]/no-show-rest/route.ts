import { route } from '@/server/access';
import { bookingDeps, markRestNoShow } from '@/server/domain/booking';
import { NoShowRestBody, paramId, readJson, respond } from '../../../bookings/_lib';

/** «Остальные не пришли»: «Не пришёл» тем из присланных записей, кто сейчас без отметки. */
export const POST = route({ perm: 'booking.attend', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, NoShowRestBody);
    return markRestNoShow(bookingDeps(), viewer, { eventId: paramId(params), opId: body.opId, bookingIds: body.bookingIds });
  }),
);
