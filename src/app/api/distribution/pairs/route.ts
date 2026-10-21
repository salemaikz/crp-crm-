// GET — спорные пары РОП (B9b, PROCESS 7.6): стороны пары только в охвате зрителя; пара без видимой стороны не выводится;
// `{items, next}`, следующая страница — `?cursor=`.
import { route } from '@/server/access';
import { listPairs } from '@/server/domain/distribution';
import { PairsQuery, readQuery, respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ req, viewer }) => respond(() => listPairs(viewer, readQuery(req, PairsQuery))));
