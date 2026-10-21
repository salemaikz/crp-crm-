import { route } from '@/server/access';
import { listHandoffMembers } from '@/server/domain/handoffs';
import { paramId, requirePurchases, respond } from '../../_lib';

/** Сотрудники отдела передачи — лист «Назначить исполнителя». */
export const GET = route({ perm: 'handoff.assign', target: 'object' }, ({ params, viewer }) =>
  respond(async () => {
    requirePurchases();
    const items = await listHandoffMembers(viewer, paramId(params));
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
