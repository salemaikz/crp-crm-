// Помощники маршрутов входа: тело JSON по схеме Zod и ответы без кэша. Origin, сессию и права
// проверяют обёртки publicRoute()/route() из @/server/access, здесь только разбор и ответы.
import type { z } from 'zod';

const BODY_MAX_BYTES = 8 * 1024;

export function json(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  const h = { 'Cache-Control': 'no-store', ...headers };
  if (body === undefined) return new Response(null, { status, headers: h });
  return Response.json(body, { status, headers: h });
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

export const retryAfterSec = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

export function rateLimited(ms: number): Response {
  const sec = retryAfterSec(ms);
  return json(429, { error: 'rate_limited', retryAfterSec: sec }, { 'Retry-After': String(sec) });
}

/**
 * Сырое тело не больше `max` байт (вебхуки, D-268): заявленная длина больше — сразу null, иначе поток читается до
 * предела; превышение — null, остаток отбрасывается. Тело не логируется.
 */
export async function readBodyLimited(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
