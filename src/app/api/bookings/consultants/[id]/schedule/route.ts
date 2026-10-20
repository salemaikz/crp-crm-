import { route } from '@/server/access';
import { bookingDeps, getSchedule, setSchedule } from '@/server/domain/booking';
import { paramId, readJson, requireFeature, respond, ScheduleBody } from '../../../_lib';

/** Недельный график консультанта и исключения от сегодня (за флагом BK_WIZARD). */
export const GET = route({ perm: 'booking.manage' }, ({ params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    return getSchedule(bookingDeps(), viewer, paramId(params));
  }),
);

/** Заменить график недели целиком; пустой список — «без графика» (работают общие часы). */
export const PUT = route({ perm: 'booking.manage' }, ({ req, params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    const body = await readJson(req, ScheduleBody);
    return setSchedule(bookingDeps(), viewer, { resourceId: paramId(params), windows: body.windows });
  }),
);
