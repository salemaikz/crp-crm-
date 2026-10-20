import { z } from 'zod';
import { changePasswordRequest } from '@/server/platform/auth';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';
import { forbidden, json, rateLimited, readBody, requireSession } from '../_lib';

const Body = z.object({ current: z.string().max(256), next: z.string().max(256) }).strict();

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  const auth = await requireSession();
  if ('error' in auth) return auth.error;
  const body = await readBody(request, Body);
  if ('error' in body) return body.error;
  const result = await changePasswordRequest({ userId: auth.session.userId, ...body.data });
  if (result.ok) {
    await setSessionCookie(result.session);
    return json(200, { ok: true });
  }
  if (result.error === 'rate_limited') return rateLimited(result.retryAfterMs ?? 1000);
  if (result.error === 'wrong_current') return json(401, { error: 'wrong_current' });
  return json(400, { error: result.error });
}
