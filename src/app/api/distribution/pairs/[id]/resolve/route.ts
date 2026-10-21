// POST — решение по паре: «Разные — тому же оператору» (`distinct`) или «Выдать другому» (`split_allowed`, комментарий
// обязателен, если общий номер рабочий у обеих сторон). Повтор того же решения безопасен.
import { NotFoundError, route } from '@/server/access';
import { resolvePair } from '@/server/domain/distribution';
import { PairResolveBody, UserIdParam, readJson, respond } from '../../../_lib';

export const POST = route({ perm: 'card.assign' }, ({ req, params, viewer }) =>
  respond(async () => {
    const id = UserIdParam.safeParse(params.id);
    if (!id.success) throw new NotFoundError();
    return resolvePair(viewer, id.data, await readJson(req, PairResolveBody));
  }),
);
