import { route } from '@/server/access';
import { dealsDeps, loseDeal } from '@/server/domain/deals';
import { LoseBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** «Проигран» (PROCESS 3.5 № 21): причина из настроек; для причин с текстом — текст 1–500 (в ленту не уходит). */
export const POST = route({ perm: 'deal.edit', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, LoseBody);
    return loseDeal(dealsDeps(), viewer, { dealId: paramId(params), ...body });
  }),
);
