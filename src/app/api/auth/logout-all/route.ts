import { logoutAllRequest } from '@/server/platform/auth';
import { clearSessionCookie } from '@/server/platform/http/sessionCookie';
import { forbidden, json, requireSession } from '../_lib';

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  const auth = await requireSession();
  if ('error' in auth) return auth.error;
  await logoutAllRequest(auth.session.userId);
  await clearSessionCookie();
  return json(204);
}
