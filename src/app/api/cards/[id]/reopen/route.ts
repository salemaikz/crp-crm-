import { pathId } from '../../../clients/_support';
import { route } from '@/server/access';
import { reopenCard } from '@/server/domain/cards';
import { ReopenBody, readBody, respondCard } from '../../_support';

// «Вернуть в обзвон» (№ 14): РОП. Без активного владельца нужен `toUserId` (400 `owner_required`).
export const POST = route({ perm: 'card.return', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = await readBody(req, ReopenBody);
  return respondCard(() => reopenCard(viewer, id, body));
});
