import { z } from 'zod';
import { acceptInviteRequest } from '@/server/platform/auth';
import { publicRoute } from '@/server/access';
import { json, rateLimited, readBody } from '@/server/platform/http/body';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';

const Body = z.object({ token: z.string().max(128), password: z.string().max(256) }).strict();

export const POST = publicRoute({ reason: 'invite', origin: 'check' }, async ({ req }) => {
  const body = await readBody(req, Body);
  if ('error' in body) return body.error;
  const r = await acceptInviteRequest({ ...body.data, ip: deriveClientIp(req.headers) });
  if (r.ok) {
    await setSessionCookie(r.session);
    // userId — метка владельца телефона (D-292), как у входа
    return json(200, { next: '/', userId: r.userId });
  }
  if (r.error === 'rate_limited') return rateLimited(r.retryAfterMs);
  if (r.error === 'invalid_token') return json(404, { error: 'invalid_token' });
  return json(400, { error: r.error });
});
