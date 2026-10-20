import { logoutAllRequest } from '@/server/platform/auth';
import { route } from '@/server/access';
import { json } from '@/server/platform/http/body';
import { clearSessionCookie } from '@/server/platform/http/sessionCookie';

// Мутация безопасности D-054: работает при «только чтение» и просроченной лицензии.
export const POST = route({ perm: 'authenticated', securityMutation: 'auth.logout_all' }, async ({ viewer }) => {
  await logoutAllRequest(viewer.userId);
  await clearSessionCookie();
  return json(204);
});
