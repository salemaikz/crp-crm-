import { route } from '@/server/access';
import { bookingDeps, getEvent, updateEvent } from '@/server/domain/booking';
import { EventPatchBody, paramId, readJson, respond } from '../../bookings/_lib';

export const GET = route({ perm: 'booking.read', target: 'object' }, ({ params, viewer }) => respond(() => getEvent(viewer, paramId(params))));

export const PATCH = route({ perm: 'booking.manage', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, EventPatchBody);
    return updateEvent(bookingDeps(), viewer, { eventId: paramId(params), seenUpdatedAt: body.seenUpdatedAt, patch: body.patch });
  }),
);
