// «Ещё» в колонке доски сделок: следующие 50 плиток этапа после курсора.
import { route } from '@/server/access';
import { getDealsColumn } from '@/server/domain/deals';
import { DealsColumnQuery, NO_STORE, readQuery } from '../../_lib';

export const GET = route({ perm: 'deal.read' }, async ({ req, viewer }) => {
  const q = readQuery(req, DealsColumnQuery);
  return Response.json(await getDealsColumn(viewer, { pipeline: q.pipeline ?? null, owner: q.owner ?? null, stage: q.stage, after: q.after ?? null }), { headers: NO_STORE });
});
