// Помощники маршрутов мессенджера: тело JSON по схеме Zod, ошибки окна чата → ответы с кодом.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import { ChatWindowError } from '@/server/domain/messenger';

export async function readJson<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > 4096) throw new BadRequestError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError('json');
  }
  return schema.parse(raw);
}

export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ChatWindowError)) throw e;
    return Response.json({ error: e.code }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

const id = z.string().min(1).max(64);
export const ChatWindowBody = z.object({ cardId: id }).strict();
export const OpenedBody = z.object({ cardId: id, templateKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable() }).strict();
export const ConsentBody = z.object({ clientId: id, action: z.enum(['given', 'revoked']) }).strict();

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
