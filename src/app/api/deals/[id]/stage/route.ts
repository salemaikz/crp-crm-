import { route } from '@/server/access';
import { dealsDeps, moveDealStage } from '@/server/domain/deals';
import { StageBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Перенос на открытый этап (PROCESS 4.2): назад — только с правом `deal.move_back` (иначе 403). */
export const POST = route({ perm: 'deal.edit', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, StageBody);
    return moveDealStage(dealsDeps(), viewer, { dealId: paramId(params), ...body });
  }),
);
