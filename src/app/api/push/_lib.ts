// Помощники маршрутов push (P8b): тело JSON ≤ 8 КБ по схеме Zod и id сессии запроса. Сессию, Origin, права и лицензию
// проверяет обёртка route(); здесь только разбор.
import { z } from 'zod';
import { BadRequestError, UnauthorizedError } from '@/server/access';
import { getSession } from '@/server/platform/auth';

const BODY_MAX_BYTES = 8 * 1024;

export async function readJson<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > BODY_MAX_BYTES) throw new BadRequestError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError('json');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError('validation');
  return parsed.data;
}

/** sessions.id текущего запроса: подписка устройства привязывается к нему (D-328). */
export async function currentSessionId(): Promise<string> {
  const s = await getSession();
  if (!s) throw new UnauthorizedError();
  return s.sessionId;
}

const b64u = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/);

/** Поля PushSubscription.toJSON() браузера и id устройства из IndexedDB. */
export const SubscribeBody = z
  .object({
    endpoint: z.string().min(1).max(1024),
    p256dh: b64u(128),
    auth: b64u(64),
    deviceId: z.string().max(64).regex(/^[A-Za-z0-9_-]*$/).default(''),
  })
  .strict();

export const UnsubscribeBody = z.object({ endpoint: z.string().min(1).max(1024).nullable().default(null) }).strict();

export const PushSettingsBody = z
  .object({
    enabled: z.boolean(),
    crossborderApproved: z.boolean(),
    decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  })
  .strict();
