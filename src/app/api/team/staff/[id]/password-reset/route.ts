// POST — ссылка сброса пароля. Мутация безопасности D-054: работает при любой лицензии.
import { route } from '@/server/access';
import { resetPassword } from '@/server/domain/team';
import { userIdOf } from '../../../_lib';

export const POST = route({ perm: 'admin', securityMutation: 'team.reset_password' }, async ({ params, viewer }) =>
  resetPassword(viewer, userIdOf(params)),
);
