import { route } from '@/server/access';
import { dealsDeps, editPurchase } from '@/server/domain/deals';
import { EditPurchaseBody, amountOf, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Правка суммы и даты покупки (РОП, D-249). Тип услуги так не меняется — `service_type_locked`; вариант (D-357) — из вариантов типа сделки, иначе 400 `variant_unknown`. */
export const PATCH = route({ perm: 'deal.move_back', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, EditPurchaseBody);
    return editPurchase(dealsDeps(), viewer, {
      dealId: paramId(params),
      opId: body.opId,
      version: body.version,
      ...(body.amountKzt !== undefined ? { amountKzt: amountOf(body.amountKzt) } : {}),
      ...(body.wonDay !== undefined ? { wonDay: body.wonDay } : {}),
      ...(body.serviceTypeKey !== undefined ? { serviceTypeKey: body.serviceTypeKey } : {}),
      ...(body.variantKey !== undefined ? { variantKey: body.variantKey } : {}),
    });
  }),
);
