import { route } from '@/server/access';
import { getHandoff } from '@/server/domain/handoffs';
import { paramId, requirePurchases, respond } from '../_lib';

/** Карточка передачи. Чужая и несуществующая — 404 с одним телом. */
export const GET = route({ perm: 'handoff.read', target: 'object' }, ({ params, viewer }) =>
  respond(async () => {
    requirePurchases();
    return getHandoff(viewer, paramId(params));
  }),
);
