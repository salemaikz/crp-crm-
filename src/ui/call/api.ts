// Запросы экрана «Звонить» к API обзвона. Каждый несёт заголовки устройства (D-063). Ответы API не кэшируются:
// `cache: 'no-store'`, service worker эти запросы не трогает.
import type { QueueResponse, SkipResponse, TodaySummary } from '@/server/domain/calls';
import type { SendResult } from './outbox';
import type { OutcomeRequest } from './types';

export type HeaderFactory = () => Record<string, string>;

async function codeOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body.code === 'string') return body.code;
    if (typeof body.error === 'string') return body.error;
  } catch {
    // тела нет или это не JSON
  }
  return undefined;
}

export interface CallApi {
  queue(q: { limit: number; exclude: readonly string[]; group: string; signal?: AbortSignal }): Promise<{ status: number; data: QueueResponse | null }>;
  skip(body: { opId: string; cardId: string }): Promise<{ status: number; data: SkipResponse | null; code?: string }>;
  sendOutcome(request: OutcomeRequest): Promise<SendResult>;
  /** Итог «Договорились — записать»: ответ нужен мастеру целиком (запись, свободные даты). Нет сети — исключение. */
  postOutcome(request: OutcomeRequest): Promise<{ status: number; json: unknown }>;
  /** Сводка «Сегодня» с сервера; нет сети или ошибка — null. */
  today(): Promise<TodaySummary | null>;
}

export function createCallApi(headers: HeaderFactory, fetchImpl: typeof fetch = (...a) => fetch(...a)): CallApi {
  const base = { cache: 'no-store' as const, credentials: 'same-origin' as const };
  return {
    async queue({ limit, exclude, group, signal }) {
      const qs = new URLSearchParams({ limit: String(limit), group });
      if (exclude.length > 0) qs.set('exclude', exclude.slice(0, 50).join(','));
      const res = await fetchImpl(`/api/calls/queue?${qs}`, { ...base, headers: headers(), signal });
      return { status: res.status, data: res.ok ? ((await res.json()) as QueueResponse) : null };
    },
    async skip(body) {
      const res = await fetchImpl('/api/calls/skips', { ...base, method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) return { status: res.status, data: (await res.json()) as SkipResponse };
      return { status: res.status, data: null, code: await codeOf(res) };
    },
    async sendOutcome(request) {
      const res = await fetchImpl('/api/calls/outcomes', { ...base, method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: res.status, ...(res.ok ? {} : { code: await codeOf(res) }) };
    },
    async postOutcome(request) {
      const res = await fetchImpl('/api/calls/outcomes', { ...base, method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async today() {
      try {
        const res = await fetchImpl('/api/calls/today', { ...base, headers: headers() });
        return res.ok ? ((await res.json()) as TodaySummary) : null;
      } catch {
        return null;
      }
    },
  };
}
