import { route } from '@/server/access';
import { addPhone, addPhoneBody, parseBody } from '@/server/domain/clients';
import { pathId, readJson } from '../../_support';

// Добавить номер: свободный — сразу в карточку, занятый или из стоп-листа — задача РОП (ответ `review`).
export const POST = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  return addPhone(viewer, id, parseBody(addPhoneBody, await readJson(req)));
});
