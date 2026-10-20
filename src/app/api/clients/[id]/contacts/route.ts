import { route } from '@/server/access';
import { addContact, addContactBody, parseBody } from '@/server/domain/clients';
import { pathId, readJson, withFieldIssues } from '../../_support';

export const POST = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(addContactBody, await readJson(req));
  return withFieldIssues(() => addContact(viewer, id, body));
});
