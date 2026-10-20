// PATCH — роль и признак администратора. Над собой нельзя (assertNotSelf в сервисе).
import { route } from '@/server/access';
import { UpdateInput, updateStaff } from '@/server/domain/team';
import { readBody, userIdOf } from '../../_lib';

export const PATCH = route({ perm: 'admin' }, async ({ req, params, viewer }) => {
  const input = await readBody(req, UpdateInput);
  return updateStaff(viewer, userIdOf(params), input);
});
