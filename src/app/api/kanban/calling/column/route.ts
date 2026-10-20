// «Ещё» в колонке вида «Обзвон»: следующие 50 карточек, начиная с `offset`.
import { route } from '@/server/access';
import { getCallingColumn } from '@/server/domain/deals';
import { CallingColumnQuery, NO_STORE, readQuery } from '../../_lib';

export const GET = route({ perm: 'card.read' }, async ({ req, viewer }) => {
  const q = readQuery(req, CallingColumnQuery);
  return Response.json(await getCallingColumn(viewer, { state: q.state, worker: q.owner ?? null, offset: q.offset }), { headers: NO_STORE });
});
