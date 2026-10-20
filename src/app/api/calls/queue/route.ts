import { route } from '@/server/access';
import { callsDeps, getQueue } from '@/server/domain/calls';
import { noteDevice, QueueQuery, readQuery, respond } from '../_lib';

/** Очередь «Звонить»: текущая карточка и следующие (до 4), счётчики по группам. */
export const GET = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, QueueQuery);
    const result = await getQueue(callsDeps(), viewer, { limit: q.limit, exclude: q.exclude, group: q.group });
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
