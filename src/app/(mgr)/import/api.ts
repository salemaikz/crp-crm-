// Клиентские вызовы /api/import: ошибка = код ответа, текст выбирает интерфейс из локали (import.errors).
export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; status: number; code: string; body: Record<string, unknown> };
export type ApiResult<T> = ApiOk<T> | ApiErr;

export async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Файл уходит сырым телом application/octet-stream (D-112), не multipart. */
export async function uploadFile<T>(url: string, file: File): Promise<ApiResult<T>> {
  return request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }, body: file });
}

async function request<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, init);
    if (res.status === 401) {
      window.location.replace('/login?next=/import');
      return { ok: false, status: 401, code: 'unauthorized', body: {} };
    }
    const data = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: string }) | null;
    if (res.ok) return { ok: true, data: data as T };
    return { ok: false, status: res.status, code: typeof data?.error === 'string' ? data.error : res.status === 400 ? 'invalid' : 'generic', body: data ?? {} };
  } catch {
    return { ok: false, status: 0, code: 'network', body: {} };
  }
}
