// Вид «Обзвон» для РОП: карточки с владельцем по состояниям `new`, `retry`, `callback`, `agreed` (B8, PROCESS 4.4).
// Охват чтения карточек ниже пространства — 403 (проверяет сервис); флаг FEATURE_KANBAN выключен — 404.
import { route } from '@/server/access';
import { getCallingBoard } from '@/server/domain/deals';
import { CallingQuery, NO_STORE, readQuery } from '../_lib';

export const GET = route({ perm: 'card.read' }, async ({ req, viewer }) => {
  const q = readQuery(req, CallingQuery);
  return Response.json(await getCallingBoard(viewer, { worker: q.owner ?? null }), { headers: NO_STORE });
});
