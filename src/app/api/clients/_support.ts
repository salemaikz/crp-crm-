// Общее для маршрутов клиентов: тело JSON, id из пути, ответ 400 с ключами полей.
import { BadRequestError, type RouteParams } from '@/server/access';
import { FieldIssuesError } from '@/server/domain/clients';

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequestError('json');
  }
}

export function pathId(params: RouteParams, name = 'id'): string {
  const v = params[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > 100) throw new BadRequestError('id');
  return v;
}

/** Ошибки значений полей → 400 `{error, detail:'fields', issues:[{key, code}]}`: только ключи и коды, без значений. */
export async function withFieldIssues<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FieldIssuesError) {
      return Response.json(
        { error: 'bad_request', detail: 'fields', issues: e.issues.map((i) => ({ key: i.key, code: i.code })) },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw e;
  }
}
