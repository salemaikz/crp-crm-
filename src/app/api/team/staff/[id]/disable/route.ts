// POST — отключение сотрудника: вход закрыт сразу, сессии отозваны. Мутация безопасности D-054.
import { route } from '@/server/access';
import { DisableInput, disableStaff } from '@/server/domain/team';
import { readBody, userIdOf } from '../../../_lib';

export const POST = route({ perm: 'admin', securityMutation: 'team.disable_user' }, async ({ req, params, viewer }) => {
  const input = await readBody(req, DisableInput);
  return disableStaff(viewer, userIdOf(params), input);
});
