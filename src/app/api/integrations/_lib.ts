// Общие помощники маршрутов интеграций: тело JSON по схеме Zod, ошибки администрирования → ответы (дизайн §7.5).
// Проверки сессии, Origin и роли администратора — обёртка route(); ответы без ключа, токена и адреса вебхука.
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import { IntegrationAdminError } from '@/server/domain/integrations';

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
  return schema.parse(raw);
}

/** Ошибка администрирования → ответ с кодом и статусом; прочие ошибки уходят в обёртку. */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof IntegrationAdminError)) throw e;
    return Response.json({ error: e.code }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const idParam = (v: string | string[] | undefined): string => {
  const s = typeof v === 'string' ? v : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new BadRequestError('id');
  return s;
};

export const PluginIdBody = z.enum(['messenger.wazzup', 'telephony.beeline', 'telephony.zadarma', 'messenger.wa_link', 'telephony.manual']);
export const ConnectBody = z.object({ pluginId: PluginIdBody, apiKey: z.string().trim().min(8).max(256) }).strict();
export const CrossborderBody = z.object({ approved: z.boolean(), decisionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
export const ChannelBody = z.object({ ownerUserId: z.string().min(1).max(64).nullable().optional(), isEnabled: z.boolean().optional() }).strict().refine((b) => b.ownerUserId !== undefined || b.isEnabled !== undefined);
