// Запросы экрана задач к /api/tasks: единый разбор ответа в ключ ошибки локали `tasks.errors.*`.
export type ErrorKey =
  | 'auto_task'
  | 'closed'
  | 'forbidden'
  | 'not_found'
  | 'deal'
  | 'op_id'
  | 'assignee'
  | 'taken'
  | 'title'
  | 'body'
  | 'invalid'
  | 'read_only'
  | 'network';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; key: ErrorKey };

const DETAILS = new Set<ErrorKey>(['auto_task', 'closed', 'deal', 'op_id', 'assignee', 'taken', 'title', 'body']);

export async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { ok: false, key: 'network' };
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return { ok: true, data: data as T };
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && DETAILS.has(detail as ErrorKey)) return { ok: false, key: detail as ErrorKey };
  if (res.status === 404) return { ok: false, key: 'not_found' };
  if (res.status === 403) return { ok: false, key: 'forbidden' };
  if (res.status === 423) return { ok: false, key: 'read_only' };
  if (res.status === 409) return { ok: false, key: 'closed' };
  if (res.status === 400) return { ok: false, key: 'invalid' };
  return { ok: false, key: 'network' };
}
