// Общее для маршрутов задач: тело JSON по схеме и id из пути (400 без подробностей).
import type { z } from 'zod';
import { BadRequestError, type RouteParams } from '@/server/access';

export async function readBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequestError('json');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new BadRequestError('invalid');
  return r.data;
}

export function pathId(params: RouteParams): string {
  const v = params.id;
  if (typeof v !== 'string' || v.length === 0 || v.length > 100) throw new BadRequestError('id');
  return v;
}
