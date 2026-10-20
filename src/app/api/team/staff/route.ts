// GET — список сотрудников; POST — приглашение. Только администратор установки.
import { route } from '@/server/access';
import { InviteInput, inviteStaff, listStaff } from '@/server/domain/team';
import { readBody } from '../_lib';

export const GET = route({ perm: 'admin' }, async ({ viewer }) => listStaff(viewer));

/** Ответ содержит ссылку приглашения — единственный раз; обёртка ставит Cache-Control: no-store. */
export const POST = route({ perm: 'admin' }, async ({ req, viewer }) => {
  const input = await readBody(req, InviteInput);
  return inviteStaff(viewer, input);
});
