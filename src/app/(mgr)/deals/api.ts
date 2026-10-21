// Клиентские вызовы досок (B8): чтение `/api/kanban/*` и перенос через маршрут сделок B6. Текст ошибок выбирает
// интерфейс из локали по коду ответа; здесь только транспорт.
import type { ClosedDeals, DealsBoard, BoardColumn } from '@/server/domain/deals/boardTypes';
import type { MoveRequest } from './deferredMove';

export interface HttpResult<T> {
  status: number;
  data: T | null;
}

async function getJson<T>(url: string): Promise<HttpResult<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    return { status: res.status, data: res.ok ? ((await res.json()) as T) : null };
  } catch {
    return { status: 0, data: null };
  }
}

const qs = (o: Record<string, string | null | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const loadBoard = (pipeline: string, owner: string) => getJson<DealsBoard>(`/api/kanban/deals${qs({ pipeline, owner })}`);
export const loadColumn = (pipeline: string, owner: string, stage: string, after: string) =>
  getJson<BoardColumn>(`/api/kanban/deals/column${qs({ pipeline, owner, stage, after })}`);
export const loadClosed = (pipeline: string, owner: string, before: string | null) => getJson<ClosedDeals>(`/api/kanban/deals/closed${qs({ pipeline, owner, before })}`);

export interface StageExtras {
  nextStep: { dueAt: number; kind: 'call' | 'meeting' } | null;
  fieldsPatch?: Record<string, unknown>;
}

/** Перенос на открытый этап: `POST /api/deals/[id]/stage` (B6). `keepalive` — уход со страницы в окне отмены. */
export async function postStage(move: MoveRequest, extras: StageExtras, keepalive: boolean): Promise<{ status: number; json: unknown }> {
  try {
    const res = await fetch(`/api/deals/${encodeURIComponent(move.dealId)}/stage`, {
      method: 'POST',
      keepalive,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opId: move.opId,
        version: move.version,
        stageKey: move.stageKey,
        nextStep: extras.nextStep,
        ...(extras.fieldsPatch ? { fieldsPatch: extras.fieldsPatch } : {}),
      }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}
