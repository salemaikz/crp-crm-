import { route } from '@/server/access';
import { bookingDeps, cancelBooking } from '@/server/domain/booking';
import { CancelBookingBody, paramId, readJson, respond } from '../../_lib';

export const POST = route({ perm: 'booking.create', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, CancelBookingBody);
    return cancelBooking(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
  }),
);
