import { route } from '@/server/access';
import { bookingDeps, getConsultant, updateConsultant } from '@/server/domain/booking';
import { ConsultantPatchBody, paramId, readJson, respond } from '../../_lib';

export const GET = route({ perm: 'booking.manage' }, ({ params, viewer }) => respond(() => getConsultant(bookingDeps(), viewer, paramId(params))));

/** Правка и выключение консультанта (`patch.active`). Устаревший `seenUpdatedAt` — 409. */
export const PATCH = route({ perm: 'booking.manage' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, ConsultantPatchBody);
    return updateConsultant(bookingDeps(), viewer, { resourceId: paramId(params), seenUpdatedAt: body.seenUpdatedAt, patch: body.patch });
  }),
);
