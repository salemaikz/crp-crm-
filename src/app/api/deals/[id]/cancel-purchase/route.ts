import { route } from '@/server/access';
import { cancelPurchase, dealsDeps } from '@/server/domain/deals';
import { CancelPurchaseBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Отмена покупки (PROCESS 3.5 № 20, 12.29): «возврат денег» или «ошибка ввода», комментарий обязателен. */
export const POST = route({ perm: 'deal.move_back', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, CancelPurchaseBody);
    return cancelPurchase(dealsDeps(), viewer, { dealId: paramId(params), ...body });
  }),
);
