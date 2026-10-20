// Общие помощники маршрутов досок (B8): разбор запросов по Zod. Проверки сессии, разрешений и охвата — обёртка route()
// и сервис досок; ответы не кэшируются.
import { z } from 'zod';

/** Строка запроса → объект по схеме; пустые значения отбрасываются. Неверный запрос — ZodError → 400. */
export function readQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== '') out[k] = v;
  return schema.parse(out);
}

const key = z.string().min(1).max(64);
const cursor = z.string().min(1).max(64);

/** Владелец сделок или `all`. */
const who = z.string().min(1).max(64);

export const DealsQuery = z.object({ pipeline: key.optional(), owner: who.optional() }).strict();
export const DealsColumnQuery = z.object({ pipeline: key.optional(), owner: who.optional(), stage: key, after: cursor.optional() }).strict();
export const ClosedQuery = z.object({ pipeline: key.optional(), owner: who.optional(), before: cursor.optional() }).strict();
export const CallingQuery = z.object({ owner: who.optional() }).strict();
export const CallingColumnQuery = z.object({ owner: who.optional(), state: key, offset: z.coerce.number().int().min(0).max(100_000).default(0) }).strict();

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
