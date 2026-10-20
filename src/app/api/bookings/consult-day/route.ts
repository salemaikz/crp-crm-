import { route } from '@/server/access';
import { bookingDeps, getConsultDay } from '@/server/domain/booking';
import { ConsultDayQuery, readQuery, requireFeature, respond } from '../_lib';

/** День консультаций РОП: консультанты и слоты, «серые» заявки, конфликты (за флагом BK_WIZARD). */
export const GET = route({ perm: 'booking.manage' }, ({ req, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    return getConsultDay(bookingDeps(), viewer, { date: readQuery(req, ConsultDayQuery).date });
  }),
);
