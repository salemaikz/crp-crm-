import { route } from '@/server/access';
import { assignHandoff } from '@/server/domain/handoffs';
import { AssignBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Назначить исполнителя из сотрудников отдела; ждущая передача принимается этим же действием. */
export const POST = route({ perm: 'handoff.assign', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, AssignBody);
    return assignHandoff(viewer, { handoffId: paramId(params), opId: body.opId, userId: body.userId });
  }),
);
