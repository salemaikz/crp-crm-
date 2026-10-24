// Сохранение одного поля на месте с карточки клиента (D-356). Поле клиента и системное — PATCH /api/clients/[id]
// {set, expect} по одному ключу; поле карточки — PATCH /api/cards/[id] {set:{custom}, expect:{custom}} без version.
// Расхождение (409) приносит новое значение в теле ответа — без лишнего GET. Тексты не здесь: только виды ответа.
import { expectOf, type FieldPayload } from '@/ui/fields/draft';
import type { FieldSave } from '@/ui/fields/save';

export type SaveTarget =
  | { object: 'client'; scope: 'system' | 'custom'; key: string; clientId: string }
  | { object: 'card'; key: string; cardId: string };

type Fetch = typeof fetch;

const hasKey = (o: unknown, key: string): o is Record<string, unknown> => !!o && typeof o === 'object' && Object.hasOwn(o, key);

/** Разбор тела 409: значение этого ключа из `current` (карточка — `current` целиком, клиент — по разделам). */
export function conflictFrom(target: SaveTarget, data: unknown): { current: unknown; known: boolean } {
  const body = (data ?? {}) as { current?: unknown };
  if (target.object === 'card') {
    return typeof data === 'object' && data !== null && 'current' in data ? { current: body.current ?? null, known: true } : { current: null, known: false };
  }
  const part = (body.current as { system?: unknown; custom?: unknown } | undefined)?.[target.scope];
  return hasKey(part, target.key) ? { current: part[target.key] ?? null, known: true } : { current: null, known: false };
}

export function saveRequest(target: SaveTarget, next: FieldPayload, prev: unknown): { url: string; body: unknown } {
  if (target.object === 'card') {
    return {
      url: `/api/cards/${encodeURIComponent(target.cardId)}`,
      body: { set: { custom: { [target.key]: next } }, expect: { custom: { [target.key]: expectOf(prev) } } },
    };
  }
  const part = target.scope;
  const other = part === 'system' ? 'custom' : 'system';
  return {
    url: `/api/clients/${encodeURIComponent(target.clientId)}`,
    body: { set: { [part]: { [target.key]: next }, [other]: {} }, expect: { [part]: { [target.key]: expectOf(prev) }, [other]: {} } },
  };
}

export async function saveInline(target: SaveTarget, next: FieldPayload, prev: unknown, fetchFn: Fetch = fetch): Promise<FieldSave> {
  const { url, body } = saveRequest(target, next, prev);
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'network' };
  }
  if (res.ok) return { ok: true };
  const data: unknown = await res.json().catch(() => null);
  if (res.status === 409) return { ok: false, kind: 'conflict', ...conflictFrom(target, data) };
  if (res.status === 400) {
    const err = (data ?? {}) as { detail?: unknown; issues?: Array<{ key?: unknown; code?: unknown }> };
    if (err.detail === 'fields') {
      const code = Array.isArray(err.issues) ? err.issues.find((i) => i.key === target.key)?.code : undefined;
      return typeof code === 'string' ? { ok: false, kind: 'fields', code } : { ok: false, kind: 'fields' };
    }
    return { ok: false, kind: 'invalid' };
  }
  if (res.status === 423) return { ok: false, kind: 'readonly' };
  if (res.status === 403 || res.status === 404) return { ok: false, kind: 'forbidden' };
  return { ok: false, kind: 'network' };
}
