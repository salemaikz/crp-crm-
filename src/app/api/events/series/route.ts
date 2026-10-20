import { route } from '@/server/access';
import { bookingDeps, createSeries, listSeries } from '@/server/domain/booking';
import { SeriesBody, readJson, respond } from '../../bookings/_lib';

export const GET = route({ perm: 'booking.manage' }, ({ viewer }) => respond(() => listSeries(bookingDeps(), viewer)));

export const POST = route({ perm: 'booking.manage' }, ({ req, viewer }) =>
  respond(async () => createSeries(bookingDeps(), viewer, await readJson(req, SeriesBody))),
);
