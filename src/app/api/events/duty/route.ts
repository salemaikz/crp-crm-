import { route } from '@/server/access';
import { bookingDeps, listDutyEvents } from '@/server/domain/booking';
import { respond } from '../../bookings/_lib';

/** Мероприятия сегодня для экрана «Дежурство»: где зритель дежурит или его роль отмечает явку. */
export const GET = route({ perm: 'booking.read' }, ({ viewer }) => respond(() => listDutyEvents(bookingDeps(), viewer)));
