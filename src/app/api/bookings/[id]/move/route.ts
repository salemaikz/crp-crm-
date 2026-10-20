import { route } from '@/server/access';
import { bookingDeps, moveBooking } from '@/server/domain/booking';
import { MoveBody, paramId, readJson, respond } from '../../_lib';

export const POST = route({ perm: 'booking.create', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, MoveBody);
    const result = await moveBooking(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
