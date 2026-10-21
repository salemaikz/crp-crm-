import { route } from '@/server/access';
import { declineHandoff } from '@/server/domain/handoffs';
import { DeclineBody, paramId, readJson, requirePurchases, respond } from '../../_lib';

/** Отклонить передачу: причина обязательна (1–500), в ленту и аудит не попадает. */
export const POST = route({ perm: 'handoff.accept', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const body = await readJson(req, DeclineBody);
    return declineHandoff(viewer, { handoffId: paramId(params), opId: body.opId, reason: body.reason });
  }),
);
