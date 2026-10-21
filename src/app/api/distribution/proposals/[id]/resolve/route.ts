// Разбор предложения: `create` — клиент и карточка сразу у предложившего, `reject` — отклонить. Повтор безопасен.
import { NotFoundError, route } from '@/server/access';
import { resolveProposal } from '@/server/domain/distribution';
import { ProposalResolveBody, UserIdParam, readJson, respond } from '../../../_lib';

export const POST = route({ perm: 'card.assign' }, ({ req, params, viewer }) =>
  respond(async () => {
    const id = UserIdParam.safeParse(params.id);
    if (!id.success) throw new NotFoundError();
    return resolveProposal(viewer, id.data, await readJson(req, ProposalResolveBody));
  }),
);
