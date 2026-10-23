import { pathId } from '../../../clients/_support';
import { respond } from '../../../bookings/_lib';
import { route } from '@/server/access';
import { moveCard } from '@/server/domain/cards';
import { MoveBody, readBody, respondCard } from '../../_support';

// № 33: выход из «Договорились» без звонка, с отметкой явки в той же транзакции (оператор и РОП, только онлайн).
// Чужая карточка и запись не открытой сделки — 404; нет права явки — 403 attendance_forbidden; смена статуса записи — 409.
export const POST = route({ perm: 'card.outcome', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = await readBody(req, MoveBody);
  return respond(() => respondCard(() => moveCard(viewer, id, body)));
});
