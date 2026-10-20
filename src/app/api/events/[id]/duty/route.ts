import { route } from '@/server/access';
import { bookingDeps, setEventDuty } from '@/server/domain/booking';
import { DutyBody, paramId, readJson, respond } from '../../../bookings/_lib';

export const PUT = route({ perm: 'booking.manage', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, DutyBody);
    return setEventDuty(bookingDeps(), viewer, { eventId: paramId(params), userIds: body.userIds });
  }),
);
