// Клиентские вызовы API записи для кабинета РОП: ошибка = машинный код домена, текст выбирает интерфейс из локали.
export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; code: string; status: number };

export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace('/login');
      return { ok: false, code: 'unauthorized', status: 401 };
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: json as T, status: res.status };
    const code = typeof json?.detail === 'string' ? json.detail : typeof json?.error === 'string' ? json.error : 'network';
    return { ok: false, code, status: res.status };
  } catch {
    return { ok: false, code: 'network', status: 0 };
  }
}

export const newKey = (): string => globalThis.crypto.randomUUID();
