import { route } from '@/server/access';
import { bookingDeps, setConfirmation } from '@/server/domain/booking';
import { ConfirmBody, paramId, readJson, respond } from '../../_lib';

export const POST = route({ perm: 'booking.create', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, ConfirmBody);
    return setConfirmation(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
  }),
);
