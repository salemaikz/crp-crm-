import { NotFoundError, route } from '@/server/access';
import { bookingDeps, getConsultStrip } from '@/server/domain/booking';
import { ConsultStripQuery, readQuery, requireFeature, respond } from '../../../_lib';

/** Полоса подбора мастера: дни, времена, предложенный консультант (за флагом BK_WIZARD). Чужая карточка — 404. */
export const GET = route({ perm: 'booking.create', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    const cardId = params.cardId;
    if (typeof cardId !== 'string' || cardId === '') throw new NotFoundError();
    const q = readQuery(req, ConsultStripQuery);
    return getConsultStrip(bookingDeps(), viewer, { cardId, eventTypeKey: q.type, directionKey: q.direction });
  }),
);
