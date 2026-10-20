// Клиентские вызовы /api/distribution: ошибка = код ответа, текст выбирает интерфейс из локали.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; key: string; remaining?: number; cap?: number };

type ErrorBody = { error?: string; detail?: string; remaining?: number; cap?: number };

const KNOWN = new Set(['not_working', 'over_cap', 'mode_off', 'invalid_settings', 'not_participant', 'forbidden', 'unauthorized', 'not_found', 'read_only']);

/** Ключ текста в distribution.errors по ответу API. */
export function errorKey(body: ErrorBody | null, status: number): string {
  if (body?.detail && KNOWN.has(body.detail)) return body.detail;
  if (body?.error && KNOWN.has(body.error)) return body.error;
  if (status === 423) return 'read_only';
  if (status === 400) return 'invalid';
  return 'generic';
}

export async function call<T>(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace('/login?next=/distribution');
      return { ok: false, key: 'unauthorized' };
    }
    const data = (await res.json().catch(() => null)) as (T & ErrorBody) | null;
    if (res.ok) return { ok: true, data: data as T };
    const out: ApiResult<T> = { ok: false, key: errorKey(data, res.status) };
    if (typeof data?.remaining === 'number' && typeof data.cap === 'number') return { ...out, remaining: data.remaining, cap: data.cap };
    return out;
  } catch {
    return { ok: false, key: 'network' };
  }
}
