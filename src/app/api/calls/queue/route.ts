import { route } from '@/server/access';
import { callsDeps, getQueue } from '@/server/domain/calls';
import { noteDevice, QueueQuery, readQuery, respond, wrongAuthor } from '../_lib';

/** Очередь «Звонить»: текущая карточка и следующие (до 4), счётчики по группам. */
export const GET = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    // Вкладка прежнего сотрудника под cookie нового: данные нового ей не отдаём, статус устройства не пишем (D-292)
    const wrong = wrongAuthor(req, viewer);
    if (wrong) return wrong;
    const q = readQuery(req, QueueQuery);
    const result = await getQueue(callsDeps(), viewer, { limit: q.limit, exclude: q.exclude, group: q.group });
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
