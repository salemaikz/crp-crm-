// Общие помощники маршрутов входа: Origin, разбор тела, ответы без кэша.
// Заменяются обёртками P4a (publicRoute/route), когда те появятся: логика входа остаётся в auth/service.
import type { z } from 'zod';
import { checkOrigin } from '@/server/platform/auth/csrf';
import { getSession, type SessionInfo } from '@/server/platform/auth/session';

const BODY_MAX_BYTES = 8 * 1024;

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  const h = { 'Cache-Control': 'no-store', ...headers };
  if (body === undefined) return new Response(null, { status, headers: h });
  return Response.json(body, { status, headers: h });
}

/** Второй рубеж CSRF (первый — src/proxy.ts): Origin обязателен на каждой мутации. */
export function forbidden(request: Request): Response | null {
  return checkOrigin(request.headers) === 'ok' ? null : json(403, { error: 'forbidden' });
}

/** Тело JSON ≤ 8 КБ по схеме Zod (.strict()); при ошибке — готовый ответ 400. */
export async function readBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<{ data: z.infer<T> } | { error: Response }> {
  const bad = { error: json(400, { error: 'validation' }) };
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > BODY_MAX_BYTES) return bad;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return bad;
  }
  if (text.length > BODY_MAX_BYTES) return bad;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { data: parsed.data } : bad;
}

/** Сессия для маршрутов «только свои»; нет — ответ 401. */
export async function requireSession(): Promise<{ session: SessionInfo } | { error: Response }> {
  const session = await getSession();
  return session ? { session } : { error: json(401, { error: 'unauthorized' }) };
}

export const retryAfterSec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export function rateLimited(ms: number): Response {
  const sec = retryAfterSec(ms);
  return json(429, { error: 'rate_limited', retryAfterSec: sec }, { 'Retry-After': String(sec) });
}
