// Клиентские вызовы /api/admin/settings: ошибка = ключ текста в settings.sales (текст выбирает интерфейс).
import type { SalesSettingsView } from './types';

export type ApiResult = { ok: true; data: SalesSettingsView } | { ok: false; key: 'conflict' | 'invalid' | 'forbidden' | 'generic' | 'network' | 'unauthorized' };

function keyOf(status: number): Exclude<ApiResult, { ok: true }>['key'] {
  if (status === 409) return 'conflict';
  if (status === 400) return 'invalid';
  if (status === 403 || status === 423) return 'forbidden';
  return 'generic';
}

export async function send(method: 'GET' | 'PATCH' | 'PUT', url: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      window.location.replace('/login?next=/settings');
      return { ok: false, key: 'unauthorized' };
    }
    const data = (await res.json().catch(() => null)) as SalesSettingsView | null;
    if (res.ok && data) return { ok: true, data };
    return { ok: false, key: keyOf(res.status) };
  } catch {
    return { ok: false, key: 'network' };
  }
}
