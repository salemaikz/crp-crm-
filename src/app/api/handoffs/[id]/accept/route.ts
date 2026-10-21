import { route } from '@/server/access';
import { acceptHandoff } from '@/server/domain/handoffs';
import { AcceptBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Принять передачу (глава отдела). Повтор того же `opId` — то же состояние без новых эффектов. */
export const POST = route({ perm: 'handoff.accept', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, AcceptBody);
    return acceptHandoff(viewer, { handoffId: paramId(params), opId: body.opId });
  }),
);
