import { route } from '@/server/access';
import { callsDeps, submitSkip } from '@/server/domain/calls';
import { noteDevice, readJson, respond, SkipBody, wrongAuthor } from '../_lib';

/** Пропуск карточки; лимит в сутки — из настроек очереди. */
export const POST = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    // Автор с устройства не совпал с сессией: ничего не пишем, даже статус устройства (D-291)
    const wrong = wrongAuthor(req, viewer);
    if (wrong) return wrong;
    const body = await readJson(req, SkipBody);
    const result = await submitSkip(callsDeps(), viewer, body);
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
