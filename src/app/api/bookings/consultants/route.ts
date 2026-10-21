import { route } from '@/server/access';
import { bookingDeps, createConsultant, listConsultants } from '@/server/domain/booking';
import { ConsultantBody, ConsultantsQuery, readJson, readQuery, respond } from '../_lib';

/** Консультанты пространства (РОП); `?inactive=1` — вместе с выключенными. */
export const GET = route({ perm: 'booking.manage' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, ConsultantsQuery);
    return listConsultants(bookingDeps(), viewer, { includeInactive: q.inactive === '1' });
  }),
);

/** Завести консультанта из сотрудника. Повтор ключа возвращает прежнего. */
export const POST = route({ perm: 'booking.manage' }, ({ req, viewer }) =>
  respond(async () => createConsultant(bookingDeps(), viewer, await readJson(req, ConsultantBody))),
);
