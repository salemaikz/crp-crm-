// «Показать закрытые»: выигранные и проигранные сделки воронки, только чтение.
import { route } from '@/server/access';
import { getClosedDeals } from '@/server/domain/deals';
import { ClosedQuery, NO_STORE, readQuery } from '../../_lib';

export const GET = route({ perm: 'deal.read' }, async ({ req, viewer }) => {
  const q = readQuery(req, ClosedQuery);
  return Response.json(await getClosedDeals(viewer, { pipeline: q.pipeline ?? null, owner: q.owner ?? null, before: q.before ?? null }), { headers: NO_STORE });
});
