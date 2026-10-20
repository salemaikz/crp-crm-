import { route } from '@/server/access';
import { parseBody, patchPhoneBody, updatePhone } from '@/server/domain/clients';
import { pathId, readJson } from '../../_support';

// «Номер не работает» (`{working:false}`) или «сделать основным» (`{primary:true}`): ровно одно действие.
export const PATCH = route({ perm: 'client.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  return updatePhone(viewer, id, parseBody(patchPhoneBody, await readJson(req)));
});
