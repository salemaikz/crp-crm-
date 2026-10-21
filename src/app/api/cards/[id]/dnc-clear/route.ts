import { pathId } from '../../../clients/_support';
import { route } from '@/server/access';
import { clearDnc } from '@/server/domain/cards';
import { DncClearBody, readBody, respondCard } from '../../_support';

// «Снять «Не звонить»» (№ 15): РОП, комментарий обязателен.
export const POST = route({ perm: 'card.unblock', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = await readBody(req, DncClearBody);
  return respondCard(() => clearDnc(viewer, id, body));
});
