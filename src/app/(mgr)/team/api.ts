// Клиентские вызовы /api/team: ошибка = код ответа (+ detail), текст выбирает интерфейс из локали.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; key: string };

type ErrorBody = { error?: string; detail?: string };

/** Ключ текста в team.errors по ответу API: сначала detail, потом код. */
export function errorKey(body: ErrorBody | null, status: number): string {
  const known = new Set([
    'exists', 'disabled', 'self_role', 'unknown_role', 'phone', 'stand_phone', 'name', 'role_required', 'no_space', 'not_activated', 'already_active',
    'forbidden', 'unauthorized', 'not_found', 'read_only', 'card_changed', 'same_owner', 'recipient', 'too_many',
  ]);
  if (body?.detail && known.has(body.detail)) return body.detail;
  if (body?.error && known.has(body.error)) return body.error;
  if (status === 400) return 'invalid';
  return 'generic';
}

export async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, loginNext = '/team'): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace(`/login?next=${loginNext}`);
      return { ok: false, key: 'unauthorized' };
    }
    const data = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, key: errorKey(data, res.status) };
  } catch {
    return { ok: false, key: 'network' };
  }
}
