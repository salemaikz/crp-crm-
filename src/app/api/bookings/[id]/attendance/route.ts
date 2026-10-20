import { route } from '@/server/access';
import { bookingDeps, markAttendance } from '@/server/domain/booking';
import { AttendanceBody, paramId, readJson, respond } from '../../_lib';

/** «Пришёл» / «Не пришёл»: РОП и дежурный своего мероприятия в день мероприятия. */
export const POST = route({ perm: 'booking.attend', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, AttendanceBody);
    return markAttendance(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
  }),
);
