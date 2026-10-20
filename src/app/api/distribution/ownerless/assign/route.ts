// «Назначить» карточкам без владельца (не новые): получатель — работающий участник. Повтор opId — прежний итог.
import { route } from '@/server/access';
import { assignOwnerless } from '@/server/domain/distribution';
import { OwnerlessAssignBody, readJson, respond } from '../../_lib';

export const POST = route({ perm: 'card.assign' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, OwnerlessAssignBody);
    const result = await assignOwnerless(viewer, body);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
