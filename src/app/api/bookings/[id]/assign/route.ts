import { route } from '@/server/access';
import { assignConsultant, bookingDeps } from '@/server/domain/booking';
import { AssignBody, paramId, readJson, respond } from '../../_lib';

/** Назначить или переназначить консультанта на запись (РОП). Повтор `opId` — без эффектов. */
export const POST = route({ perm: 'booking.manage', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, AssignBody);
    return assignConsultant(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
  }),
);
