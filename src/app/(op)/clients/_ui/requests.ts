// Запросы клиентских компонентов к API клиентов: единый разбор ответа (200 / 400 поля / 409 / 403 / сеть).
import type { SubmitResult } from './FieldsForm';

export async function send(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<{ result: SubmitResult; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { result: { ok: false, kind: 'network' }, data: null };
  }
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return { result: { ok: true }, data };
  const err = (data ?? {}) as { detail?: string; issues?: Array<{ key: string; code: string }> };
  if (res.status === 400 && err.detail === 'fields' && Array.isArray(err.issues)) {
    return { result: { ok: false, kind: 'fields', issues: err.issues }, data };
  }
  if (res.status === 409) return { result: { ok: false, kind: 'conflict' }, data };
  if (res.status === 403 || res.status === 404 || res.status === 423) return { result: { ok: false, kind: 'forbidden' }, data };
  if (res.status === 400) return { result: { ok: false, kind: 'invalid' }, data };
  return { result: { ok: false, kind: 'network' }, data };
}
