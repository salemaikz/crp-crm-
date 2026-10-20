// Общее для маршрутов /api/team: разбор тела и id из пути.
import { BadRequestError } from '@/server/access/errors';
import { UserId } from '@/server/domain/team';

/** Тело JSON по схеме. Пустое тело = `{}`; битый JSON — 400. Ошибки схемы превращает в 400 обёртка. */
export async function readBody<T>(req: Request, schema: { parse(raw: unknown): T }): Promise<T> {
  const text = await req.text();
  if (text.length > 4096) throw new BadRequestError('too_large');
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError('json');
    }
  }
  return schema.parse(raw);
}

export function userIdOf(params: Record<string, string | string[] | undefined>): string {
  return UserId.parse(params.id);
}
