// Общие помощники маршрутов раздачи: разбор тел и запросов (Zod), единые ответы на ошибки домена
// (docs/distribution-design.md §6). Проверки сессии, Origin, ролей и охвата — обёртка route().
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import { DistributionDomainError, failureBody } from '@/server/domain/distribution';

const BODY_MAX_BYTES = 16 * 1024;

/** Тело JSON ≤ 16 КБ по схеме Zod (.strict()). Неверное тело — 400 (ZodError превращает обёртка). */
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

/** Строка запроса по схеме Zod; пустые значения (`?userId=`) считаются отсутствующими. */
export function readQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== '') out[k] = v;
  return schema.parse(out);
}

/**
 * Ошибка домена → ответ: `not_participant` — 400, остальные — 409 с кодом (`over_cap` — и «осталось N из M»).
 * Не доменные ошибки уходят в обёртку.
 */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof DistributionDomainError)) throw e;
    return Response.json(failureBody(e), { status: e.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

// ---------------------------------------------------------------------------
// Схемы тел и запросов
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

export const PoolQuery = z.object({ cursor: z.string().max(200).optional(), limit: int(1, 100).optional() }).strict();
export const LogQuery = z.object({ from: date, to: date, userId: id.optional() }).strict();
export const ParticipantBody = z.object({ inDistribution: z.boolean() }).strict();
export const UserIdParam = id;

export const IssueBody = z.union([
  z.object({ opId: z.string().uuid(), toUserId: id, cardIds: z.array(id).min(1).max(100) }).strict(),
  z.object({ opId: z.string().uuid(), toUserId: id, count: z.number().int().min(1).max(200) }).strict(),
]);
