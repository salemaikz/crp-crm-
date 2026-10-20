import { logoutRequest } from '@/server/platform/auth';
import { clearSessionCookie, readSessionToken } from '@/server/platform/http/sessionCookie';
import { forbidden, json } from '../_lib';

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  await logoutRequest(await readSessionToken());
  await clearSessionCookie();
  return json(204);
}
