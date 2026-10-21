// Отмена отсутствия: временные владельцы снимаются сразу. Повтор отмены возвращает прежний ответ.
import { NotFoundError, route } from '@/server/access';
import { cancelAbsence } from '@/server/domain/distribution';
import { UserIdParam, respond } from '../../../_lib';

export const POST = route({ perm: 'distribution.manage' }, ({ params, viewer }) =>
  respond(async () => {
    const id = UserIdParam.safeParse(params.id);
    if (!id.success) throw new NotFoundError();
    return cancelAbsence(viewer, id.data);
  }),
);
