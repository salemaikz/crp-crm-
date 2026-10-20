import { z } from 'zod';
import { acceptInviteRequest } from '@/server/platform/auth';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';
import { forbidden, json, rateLimited, readBody } from '../../_lib';

const Body = z.object({ token: z.string().max(128), password: z.string().max(256) }).strict();

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  const body = await readBody(request, Body);
  if ('error' in body) return body.error;
  const r = await acceptInviteRequest({ ...body.data, ip: deriveClientIp(request.headers) });
  if (r.ok) {
    await setSessionCookie(r.session);
    return json(200, { next: '/' });
  }
  if (r.error === 'rate_limited') return rateLimited(r.retryAfterMs);
  if (r.error === 'invalid_token') return json(404, { error: 'invalid_token' });
  return json(400, { error: r.error });
}
