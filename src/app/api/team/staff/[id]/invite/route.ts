// POST — повторная отправка приглашения (новая ссылка, прежняя гасится); DELETE — отзыв.
import { route } from '@/server/access';
import { ResendInput, resendInvite, revokeInvite } from '@/server/domain/team';
import { readBody, userIdOf } from '../../../_lib';

export const POST = route({ perm: 'admin' }, async ({ req, params, viewer }) => {
  const input = await readBody(req, ResendInput);
  return resendInvite(viewer, userIdOf(params), input);
});

export const DELETE = route({ perm: 'admin' }, async ({ params, viewer }) => revokeInvite(viewer, userIdOf(params)));
