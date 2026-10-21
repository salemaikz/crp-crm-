import { pathId } from '../../../clients/_support';
import { route } from '@/server/access';
import { closeCard } from '@/server/domain/cards';
import { CloseBody, readBody, respondCard } from '../../_support';

// «Не целевой» и «Полный отказ» из меню карточки без звонка (№ 11, 12): оператор и РОП.
export const POST = route({ perm: 'card.outcome', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = await readBody(req, CloseBody);
  return respondCard(() => closeCard(viewer, id, body));
});
