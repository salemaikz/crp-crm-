// POST — слияние пары по отпечатку предпросмотра (B9b, FEATURE_MERGE; выключен — 404). Устаревший отпечаток — 409
// `changed`, конфликт записей или карточка в чужом пространстве — 409 с кодом. Повтор opId возвращает прежний ответ.
import { NotFoundError, route } from '@/server/access';
import { applyMerge } from '@/server/domain/intake';
import { MergeBody, UserIdParam, readJson } from '../../../_lib';

export const POST = route({ perm: 'client.merge' }, async ({ req, params, viewer }) => {
  const id = UserIdParam.safeParse(params.id);
  if (!id.success) throw new NotFoundError();
  return applyMerge(viewer, id.data, await readJson(req, MergeBody));
});
