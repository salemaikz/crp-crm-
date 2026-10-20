// Ручная выдача РОП («Раздать выбранные»): выбранные карточки или первые N из пула. Повтор opId — прежний итог.
import { route } from '@/server/access';
import { issueCards } from '@/server/domain/distribution';
import { IssueBody, readJson, respond } from '../_lib';

export const POST = route({ perm: 'card.assign' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, IssueBody);
    const result = await issueCards(viewer, body);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
