import { route } from '@/server/access';
import { bookingDeps, registerWalkIn } from '@/server/domain/booking';
import { WalkInBody, paramId, readJson, respond } from '../../../bookings/_lib';

/** Гость без записи: ответ «найден / новый / проверит РОП» без имени, id клиента и владельца. 201; повтор ключа — 200. */
export const POST = route({ perm: 'booking.walk_in', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, WalkInBody);
    const result = await registerWalkIn(bookingDeps(), viewer, { eventId: paramId(params), ...body });
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
