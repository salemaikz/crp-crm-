import { route } from '@/server/access';
import { bookingDeps, listMyConsultations } from '@/server/domain/booking';
import { MineQuery, readQuery, requireFeature, respond } from '../_lib';

/** «Мои консультации»: записи к ресурсу зрителя в окне дат (≤ 62 дня); клиент — только внутри окна доступа. */
export const GET = route({ perm: 'booking.read' }, ({ req, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    return listMyConsultations(bookingDeps(), viewer, readQuery(req, MineQuery));
  }),
);
