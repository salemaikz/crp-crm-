// Пул без владельца: сводка и страница готовых к раздаче карточек (РОП, `pool.read`).
import { route } from '@/server/access';
import { getPool } from '@/server/domain/distribution';
import { PoolQuery, readQuery, respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, PoolQuery);
    return getPool(viewer, { cursor: q.cursor ?? null, limit: q.limit ?? 50 });
  }),
);
