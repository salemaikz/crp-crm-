import { route } from '@/server/access';
import { bookingDeps, listAssignCandidates } from '@/server/domain/booking';
import { paramId, respond } from '../../_lib';

/** Кому можно отдать запись сейчас, лучший первым. */
export const GET = route({ perm: 'booking.manage', target: 'object' }, ({ params, viewer }) =>
  respond(() => listAssignCandidates(bookingDeps(), viewer, paramId(params))),
);
