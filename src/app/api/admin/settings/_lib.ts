// Общее для маршрутов /api/admin/settings: разбор тела и ответ 400 с путями ошибок (без значений).
import { BadRequestError } from '@/server/access/errors';
import { SettingsInvalidError } from '@/server/domain/admin';

/** Тело JSON по схеме. Ошибка схемы — 400 с путями полей, значения в ответ не попадают. */
export async function readBody<T>(req: Request, schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: PropertyKey[] }[] } } }): Promise<T> {
  const text = await req.text();
  if (text.length > 65_536) throw new BadRequestError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError('json');
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new SettingsInvalidError(r.error.issues.map((i) => ({ path: i.path.map(String).join('.') })));
  return r.data;
}

/** Выполнить сервис; проверку значений превратить в 400 `invalid` с `issues[].path`. Остальное — на обёртку. */
export async function withIssues(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SettingsInvalidError) {
      return Response.json({ error: 'bad_request', detail: 'invalid', issues: e.issues }, { status: 400 });
    }
    throw e;
  }
}
