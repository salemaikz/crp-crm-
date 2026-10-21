import { route } from '@/server/access';
import { bookingDeps, getDutyCandidates, setEventDuty } from '@/server/domain/booking';
import { DutyBody, paramId, readJson, respond } from '../../../bookings/_lib';

/** Дежурные мероприятия и кого можно назначить (РОП). */
export const GET = route({ perm: 'booking.manage', target: 'object' }, ({ params, viewer }) =>
  respond(() => getDutyCandidates(bookingDeps(), viewer, paramId(params))),
);

export const PUT = route({ perm: 'booking.manage', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, DutyBody);
    return setEventDuty(bookingDeps(), viewer, { eventId: paramId(params), userIds: body.userIds });
  }),
);
