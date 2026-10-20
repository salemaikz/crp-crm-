// Включить или выключить участие сотрудника в раздаче. Аудит пишет домен в той же транзакции.
import { NotFoundError, route } from '@/server/access';
import { setParticipation } from '@/server/domain/distribution';
import { ParticipantBody, UserIdParam, readJson, respond } from '../../_lib';

export const PUT = route({ perm: 'distribution.manage' }, ({ req, params, viewer }) =>
  respond(async () => {
    const userId = UserIdParam.safeParse(params.userId);
    if (!userId.success) throw new NotFoundError();
    const body = await readJson(req, ParticipantBody);
    return setParticipation(viewer, { userId: userId.data, inDistribution: body.inDistribution });
  }),
);
