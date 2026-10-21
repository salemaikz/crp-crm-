// POST — передача клиента одним действием из карточки (B9a): главная карточка и её двойники того же владельца.
// Версия карточки не совпала — 409 `card_changed`. Чужая карточка и несуществующая отвечают одинаково (404).
import { route } from '@/server/access';
import { TransferOneInput, transferOne } from '@/server/domain/team';
import { readBody } from '../../_lib';

export const POST = route({ perm: 'client.transfer' }, async ({ req, viewer }) => {
  const input = await readBody(req, TransferOneInput);
  return transferOne(viewer, input);
});
