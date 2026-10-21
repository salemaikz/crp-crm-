// Клиентские вызовы /api/integrations: ошибка = код ответа; текст выбирает интерфейс из локали.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; key: string };

const KNOWN = new Set(['provider_error', 'no_secrets_key', 'no_origin', 'crossborder_not_approved', 'not_licensed', 'bad_owner', 'state_changed', 'already_enabled', 'enable_in_progress']);

export async function call<T>(method: 'POST' | 'PATCH', url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace('/login?next=/integrations');
      return { ok: false, key: 'error' };
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, key: data?.error && KNOWN.has(data.error) ? `errors.${data.error}` : 'error' };
  } catch {
    return { ok: false, key: 'error' };
  }
}
