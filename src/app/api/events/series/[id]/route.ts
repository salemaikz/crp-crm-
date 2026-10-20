import { route } from '@/server/access';
import { bookingDeps, updateSeries } from '@/server/domain/booking';
import { SeriesPatchBody, paramId, readJson, respond } from '../../../bookings/_lib';

export const PATCH = route({ perm: 'booking.manage' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, SeriesPatchBody);
    return updateSeries(bookingDeps(), viewer, { seriesId: paramId(params), seenUpdatedAt: body.seenUpdatedAt, patch: body.patch });
  }),
);
