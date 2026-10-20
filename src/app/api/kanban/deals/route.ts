// Доска сделок: колонки открытых этапов воронки, счётчики, закрытые за 30 суток (B8, D-266). Выключена флагом FEATURE_KANBAN.
import { route } from '@/server/access';
import { getDealsBoard } from '@/server/domain/deals';
import { DealsQuery, NO_STORE, readQuery } from '../_lib';

export const GET = route({ perm: 'deal.read' }, async ({ req, viewer }) => {
  const q = readQuery(req, DealsQuery);
  return Response.json(await getDealsBoard(viewer, { pipeline: q.pipeline ?? null, owner: q.owner ?? null }), { headers: NO_STORE });
});
