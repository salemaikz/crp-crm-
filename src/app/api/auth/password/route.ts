import { z } from 'zod';
import { changePasswordRequest } from '@/server/platform/auth';
import { route } from '@/server/access';
import { json, rateLimited, readBody } from '@/server/platform/http/body';
import { setSessionCookie } from '@/server/platform/http/sessionCookie';

const Body = z.object({ current: z.string().max(256), next: z.string().max(256) }).strict();

// Смена своего пароля: мутация безопасности D-054; старые сессии отозваны, этому устройству выдана новая.
export const POST = route({ perm: 'authenticated', securityMutation: 'auth.change_own_password' }, async ({ req, viewer }) => {
  const body = await readBody(req, Body);
  if ('error' in body) return body.error;
  const result = await changePasswordRequest({ userId: viewer.userId, ...body.data });
  if (result.ok) {
    await setSessionCookie(result.session);
    return json(200, { ok: true });
  }
  if (result.error === 'rate_limited') return rateLimited(result.retryAfterMs ?? 1000);
  if (result.error === 'wrong_current') return json(401, { error: 'wrong_current' });
  return json(400, { error: result.error });
});
