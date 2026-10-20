import { z } from 'zod';
import { inspectInviteRequest } from '@/server/platform/auth';
import { publicRoute } from '@/server/access';
import { json, rateLimited, readBody } from '@/server/platform/http/body';
import { deriveClientIp } from '@/server/platform/http/clientIp';

const Body = z.object({ token: z.string().max(128) }).strict();

export const POST = publicRoute({ reason: 'invite', origin: 'check' }, async ({ req }) => {
  const body = await readBody(req, Body);
  if ('error' in body) return body.error;
  const r = await inspectInviteRequest({ token: body.data.token, ip: deriveClientIp(req.headers) });
  if (r.ok) return json(200, r.preview);
  if (r.error === 'rate_limited') return rateLimited(r.retryAfterMs ?? 1000);
  return json(404, { error: 'invalid_token' });
});
