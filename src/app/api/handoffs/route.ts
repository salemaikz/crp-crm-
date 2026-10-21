import { route } from '@/server/access';
import { listHandoffs, type HandoffStatus } from '@/server/domain/handoffs';
import { STATUS_GROUPS, requirePurchases, respond } from './_lib';

/** Входящие передачи в охвате роли: `?group=waiting|working|closed` (по умолчанию — ждущие и принятые). */
export const GET = route({ perm: 'handoff.read' }, ({ req, viewer }) =>
  respond(async () => {
    requirePurchases();
    const group = new URL(req.url).searchParams.get('group');
    const statuses: readonly HandoffStatus[] | undefined = group !== null && Object.hasOwn(STATUS_GROUPS, group) ? STATUS_GROUPS[group as keyof typeof STATUS_GROUPS] : undefined;
    const items = await listHandoffs(viewer, statuses ? { statuses } : {});
    return Response.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
