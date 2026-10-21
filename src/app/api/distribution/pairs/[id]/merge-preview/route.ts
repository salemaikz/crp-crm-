// GET — предпросмотр слияния пары (B9b, FEATURE_MERGE; выключен — 404): итог карточки, что переедет, заполняемые поля,
// конфликты и отпечаток, без которого слияние не применится. Ничего не пишет.
import { NotFoundError, route } from '@/server/access';
import { previewMerge } from '@/server/domain/intake';
import { MergeChoiceQuery, UserIdParam, readQuery } from '../../../_lib';

export const GET = route({ perm: 'client.merge' }, ({ req, params, viewer }) => {
  const id = UserIdParam.safeParse(params.id);
  if (!id.success) throw new NotFoundError();
  return previewMerge(viewer, id.data, readQuery(req, MergeChoiceQuery));
});
