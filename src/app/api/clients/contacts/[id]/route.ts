import { route } from '@/server/access';
import { archiveContactById, parseBody, patchContactBody, updateContact } from '@/server/domain/clients';
import { pathId, readJson, withFieldIssues } from '../../_support';

// Правка контакта (`set` + `expect`) или отправка в архив (`{archived:true}` отдельным телом).
export const PATCH = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(patchContactBody, await readJson(req));
  if ('archived' in body) return archiveContactById(viewer, id);
  return withFieldIssues(() => updateContact(viewer, id, body));
});
