import { z } from 'zod';
import { inspectInviteRequest } from '@/server/platform/auth';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { forbidden, json, rateLimited, readBody } from '../../_lib';

const Body = z.object({ token: z.string().max(128) }).strict();

export async function POST(request: Request): Promise<Response> {
  const blocked = forbidden(request);
  if (blocked) return blocked;
  const body = await readBody(request, Body);
  if ('error' in body) return body.error;
  const r = await inspectInviteRequest({ token: body.data.token, ip: deriveClientIp(request.headers) });
  if (r.ok) return json(200, r.preview);
  if (r.error === 'rate_limited') return rateLimited(r.retryAfterMs ?? 1000);
  return json(404, { error: 'invalid_token' });
}
