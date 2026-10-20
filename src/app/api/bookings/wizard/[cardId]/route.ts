import { DEFAULT_LOCALE } from '@/i18n/config';
import { NotFoundError, route } from '@/server/access';
import { bookingDeps, getBookingWizard } from '@/server/domain/booking';
import { respond } from '../../_lib';

// Язык интерфейса пока один (src/i18n/request.ts): с включением kk локаль берётся из запроса next-intl.
/** Мастер записи одним чтением: вкладки, ближайшие мероприятия, дни и время заявки (B3a). Чужая карточка — 404. */
export const GET = route({ perm: 'booking.create', target: 'object' }, ({ viewer, params }) =>
  respond(async () => {
    const cardId = params.cardId;
    if (typeof cardId !== 'string' || cardId === '') throw new NotFoundError();
    return getBookingWizard(bookingDeps(), viewer, { cardId, locale: DEFAULT_LOCALE });
  }),
);
