// Клиентские вызовы /api/distribution/pairs: ошибка = код ответа (+ detail), текст выбирает интерфейс из pairs.errors.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; key: string };

type ErrorBody = { error?: string; detail?: string };

const KNOWN = new Set([
  'comment_required', 'not_open', 'changed', 'booking_conflict', 'other_space', 'op_id',
  'forbidden', 'unauthorized', 'not_found', 'read_only',
]);

export function errorKey(body: ErrorBody | null, status: number): string {
  if (body?.detail && KNOWN.has(body.detail)) return body.detail;
  if (body?.error && KNOWN.has(body.error)) return body.error;
  if (status === 423) return 'read_only';
  if (status === 400) return 'invalid';
  return 'generic';
}

export async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace('/login?next=/pairs');
      return { ok: false, key: 'unauthorized' };
    }
    const data = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, key: errorKey(data, res.status) };
  } catch {
    return { ok: false, key: 'network' };
  }
}
