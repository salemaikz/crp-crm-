import { route } from '@/server/access';
import { getClientDeals } from '@/server/domain/clients';
import { pathId } from '../../_support';

// История сделок клиента (до 50, новые сверху) в пределах охвата `deal.read`.
export const GET = route({ perm: 'deal.read', target: 'object' }, async ({ params, viewer }) => getClientDeals(viewer, pathId(params)));
