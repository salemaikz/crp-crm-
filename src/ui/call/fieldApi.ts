// Сохранение одного поля из карточки обзвона (pipeline-v2 §9.6): поле клиента — PATCH /api/clients/[id], поле карточки —
// PATCH /api/cards/[id] без версии. Версию заменяет `expect` (что поле было до правки): итог в очереди устройства
// не мешает. Расхождение — 409; новое значение приходит в ответе (карточка) или читается из карточки клиента.
import { expectOf, type FieldPayload } from '@/ui/fields/draft';

export type { FieldSave } from '@/ui/fields/save';
import type { FieldSave } from '@/ui/fields/save';

type Target = { object: 'client' | 'card'; key: string; cardId: string; clientId: string };
type Fetch = typeof fetch;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Значение поля из ответа GET /api/clients/[id] (после 409 по полю клиента). */
function clientFieldValue(data: unknown, key: string): { known: boolean; value: unknown } {
  const list = (data as { fields?: { fields?: Array<{ key?: unknown; value?: unknown }> } } | null)?.fields?.fields;
  const f = Array.isArray(list) ? list.find((x) => x.key === key) : undefined;
  return f ? { known: true, value: f.value ?? null } : { known: false, value: null };
}

export async function saveField(target: Target, prev: unknown, next: FieldPayload, fetchFn: Fetch = fetch): Promise<FieldSave> {
  const url = target.object === 'card' ? `/api/cards/${encodeURIComponent(target.cardId)}` : `/api/clients/${encodeURIComponent(target.clientId)}`;
  const body = { set: { custom: { [target.key]: next } }, expect: { custom: { [target.key]: expectOf(prev) } } };
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'network' };
  }
  if (res.ok) return { ok: true };
  const data: unknown = await res.json().catch(() => null);
  if (res.status === 409) {
    if (target.object === 'card' && data && typeof data === 'object' && 'current' in data) {
      return { ok: false, kind: 'conflict', current: (data as { current: unknown }).current, known: true };
    }
    if (target.object === 'client') {
      try {
        const r = await fetchFn(url, { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const cur = clientFieldValue(await r.json(), target.key);
          return { ok: false, kind: 'conflict', current: cur.value, known: cur.known };
        }
      } catch {
        // сеть пропала: значение неизвестно
      }
    }
    return { ok: false, kind: 'conflict', current: null, known: false };
  }
  if (res.status === 400 && (data as { detail?: unknown } | null)?.detail === 'fields') return { ok: false, kind: 'fields' };
  if (res.status === 400) return { ok: false, kind: 'invalid' };
  if (res.status === 403 || res.status === 404 || res.status === 423) return { ok: false, kind: 'forbidden' };
  return { ok: false, kind: 'network' };
}
