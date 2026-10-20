import { z } from 'zod';
import { loginRequest } from '@/server/platform/auth';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';
import { forbidden, json, rateLimited, readBody, retryAfterSec } from '../_lib';

const Body = z.object({ phone: z.string().max(32), password: z.string().max(256), next: z.string().max(2048).optional() }).strict();

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  const body = await readBody(request, Body);
  if ('error' in body) return body.error;
  const result = await loginRequest({ ...body.data, ip: deriveClientIp(request.headers) });
  if (result.ok) {
    await setSessionCookie(result.session);
    return json(200, { next: result.next });
  }
  if (result.error === 'validation') return json(400, { error: 'validation' });
  if (result.error === 'rate_limited') return rateLimited(result.retryAfterMs);
  return json(401, { error: 'invalid', ...(result.retryAfterMs ? { retryAfterSec: retryAfterSec(result.retryAfterMs) } : {}) });
}
