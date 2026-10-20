import { route } from '@/server/access';
import { getClientCard, parseBody, patchBody, updateClient } from '@/server/domain/clients';
import { pathId, readJson, withFieldIssues } from '../_support';

export const GET = route({ perm: 'client.read', target: 'object' }, async ({ params, viewer }) => getClientCard(viewer, pathId(params)));

// Правка полей клиента: `set` + `expect` (что видел интерфейс); расхождение — 409.
export const PATCH = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(patchBody, await readJson(req));
  return withFieldIssues(() => updateClient(viewer, id, body));
});
