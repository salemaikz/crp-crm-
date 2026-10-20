// Раздел «Без владельца (не новые)»: рабочие карточки без владельца (страховка, в норме пусто), РОП с `pool.read`.
import { route } from '@/server/access';
import { listOwnerless } from '@/server/domain/distribution';
import { OwnerlessQuery, readQuery, respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, OwnerlessQuery);
    return listOwnerless(viewer, { cursor: q.cursor ?? null, limit: q.limit ?? 50 });
  }),
);
