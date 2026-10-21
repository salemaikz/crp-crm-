import { route } from '@/server/access';
import { dealsDeps, getDealPage } from '@/server/domain/deals';
import { paramId, requirePurchases, respond } from '../_lib';

/** Страница сделки: этап, сумма, история, записи, передача и доступные действия. Чужая — 404. */
export const GET = route({ perm: 'deal.read', target: 'object' }, ({ params, viewer }) =>
  respond(async () => {
    requirePurchases();
    return getDealPage(dealsDeps(), viewer, paramId(params));
  }),
);
