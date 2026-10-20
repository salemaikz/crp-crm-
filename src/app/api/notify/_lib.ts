// Помощники маршрутов уведомлений: разбор тела и запроса по схеме Zod. Сессию, Origin и права проверяет обёртка route().
import { z } from 'zod';
import { BadRequestError } from '@/server/access';

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

export function readQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== '') out[k] = v;
  return schema.parse(out);
}

export const ListQuery = z
  .object({
    cursor: z.string().regex(/^\d{1,16}$/).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .strict();

/** Отметить прочитанными: все свои или перечисленные id. */
export const ReadBody = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }).strict(),
]);
