import { route } from '@/server/access';
import { bookingDeps, cancelEvent } from '@/server/domain/booking';
import { CancelEventBody, paramId, readJson, respond } from '../../../bookings/_lib';

/** Отмена мероприятия каскадом: активные записи → «отменена: мероприятие отменено». */
export const POST = route({ perm: 'booking.manage', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, CancelEventBody);
    return cancelEvent(bookingDeps(), viewer, { eventId: paramId(params), opId: body.opId });
  }),
);
