import { route } from '@/server/access';
import { dealsDeps, registerPurchase } from '@/server/domain/deals';
import { PurchaseBody, amountOf, readJson, requirePurchases, respond } from '../_lib';

/**
 * Регистрация покупки (PROCESS 3.5 № 19): карточка из тела, поэтому раздел; охват карточки проверяет сервис
 * (чужая — 404 тем же телом). 201; повтор того же `requestId` — 200 и `replayed`.
 */
export const POST = route({ perm: 'deal.purchase' }, ({ req, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, PurchaseBody);
    const result = await registerPurchase(dealsDeps(), viewer, { ...body, amountKzt: amountOf(body.amountKzt) });
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
