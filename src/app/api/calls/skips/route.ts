import { route } from '@/server/access';
import { callsDeps, submitSkip } from '@/server/domain/calls';
import { noteDevice, readJson, respond, SkipBody } from '../_lib';

/** Пропуск карточки; лимит в сутки — из настроек очереди. */
export const POST = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, SkipBody);
    const result = await submitSkip(callsDeps(), viewer, body);
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
