import { route } from '@/server/access';
import { getBooking } from '@/server/domain/booking';
import { paramId, respond } from '../_lib';

export const GET = route({ perm: 'booking.read', target: 'object' }, ({ params, viewer }) => respond(() => getBooking(viewer, paramId(params))));
