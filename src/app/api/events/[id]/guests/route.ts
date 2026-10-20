import { route } from '@/server/access';
import { bookingDeps, listGuests } from '@/server/domain/booking';
import { paramId, respond } from '../../../bookings/_lib';

/** Гости мероприятия: имя, контакт, хвост номера (D-072); дежурный — все гости своего мероприятия сегодня. */
export const GET = route({ perm: 'booking.read', target: 'object' }, ({ params, viewer }) => respond(() => listGuests(bookingDeps(), viewer, paramId(params))));
