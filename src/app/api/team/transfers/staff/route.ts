// GET — сотрудники для диалогов передачи (кому и от кого) и число связанных карточек при `cardId`. Только `client.transfer`.
import { route } from '@/server/access';
import { listTransferStaff } from '@/server/domain/team';

export const GET = route({ perm: 'client.transfer' }, async ({ req, viewer }) => {
  const cardId = new URL(req.url).searchParams.get('cardId');
  return listTransferStaff(viewer, cardId && cardId.length <= 100 ? { cardId } : {});
});
