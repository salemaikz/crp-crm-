import { route } from '@/server/access';
import { ClientFieldConflictError, getClientCard, parseBody, patchBody, updateClient } from '@/server/domain/clients';
import { pathId, readJson, withFieldIssues } from '../_support';

export const GET = route({ perm: 'client.read', target: 'object' }, async ({ params, viewer }) => getClientCard(viewer, pathId(params)));

// Правка полей клиента: `set` + `expect` (что видел интерфейс); расхождение — 409. Тело 409 несёт `current`
// по ключам запроса — только видимым зрителю (ввод на месте, D-356), чтобы не перечитывать карточку.
export const PATCH = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(patchBody, await readJson(req));
  try {
    return await withFieldIssues(() => updateClient(viewer, id, body));
  } catch (e) {
    if (e instanceof ClientFieldConflictError) {
      return Response.json({ error: 'conflict', detail: e.detail, current: e.current }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    throw e;
  }
});
