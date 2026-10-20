import { z } from 'zod';
import { loginRequest } from '@/server/platform/auth';
import { publicRoute } from '@/server/access';
import { json, rateLimited, readBody, retryAfterSec } from '@/server/platform/http/body';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';

const Body = z.object({ phone: z.string().max(32), password: z.string().max(256), next: z.string().max(2048).optional() }).strict();

// Вход: без сессии, Origin проверяет обёртка (D-095), cookie ставится после успешной проверки пароля.
export const POST = publicRoute({ reason: 'auth', origin: 'check' }, async ({ req }) => {
  const body = await readBody(req, Body);
  if ('error' in body) return body.error;
  const result = await loginRequest({ ...body.data, ip: deriveClientIp(req.headers) });
  if (result.ok) {
    await setSessionCookie(result.session);
    return json(200, { next: result.next });
  }
  if (result.error === 'validation') return json(400, { error: 'validation' });
  if (result.error === 'rate_limited') return rateLimited(result.retryAfterMs);
  return json(401, { error: 'invalid', ...(result.retryAfterMs ? { retryAfterSec: retryAfterSec(result.retryAfterMs) } : {}) });
});
