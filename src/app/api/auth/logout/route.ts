import { logoutRequest } from '@/server/platform/auth';
import { publicRoute } from '@/server/access';
import { json } from '@/server/platform/http/body';
import { clearSessionCookie, readSessionToken } from '@/server/platform/http/sessionCookie';

// Выход работает по токену cookie и не строит Viewer: он нужен и тогда, когда настроек или роли нет.
export const POST = publicRoute({ reason: 'auth', origin: 'check' }, async () => {
  await logoutRequest(await readSessionToken());
  await clearSessionCookie();
  return json(204);
});
