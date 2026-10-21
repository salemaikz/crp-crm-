// Запросы экрана «Звонить» к API обзвона. Каждый несёт заголовки устройства (D-063) и сотрудника (X-Call-Author):
// сервер не примет итог под чужой сессией (D-291) и не отдаст вкладке прежнего сотрудника очередь нового (D-292). Ответы API не кэшируются: `cache: 'no-store'`,
// service worker эти запросы не трогает.
import type { QueueResponse, SkipResponse, TodaySummary } from '@/server/domain/calls';
import { WRONG_USER, type SendResult } from './outbox';
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

/** Ответ «на телефоне вошёл другой сотрудник» (D-291, D-292). */
export const isWrongUser = (r: { status: number; code?: string }): boolean => r.status === 409 && r.code === WRONG_USER;

export interface CallApi {
  /** 409 с `code: 'wrong_user'` — на телефоне вошёл другой сотрудник, страница устарела. */
  queue(q: { limit: number; exclude: readonly string[]; group: string; signal?: AbortSignal }): Promise<{ status: number; data: QueueResponse | null; code?: string }>;
  skip(body: { opId: string; cardId: string }): Promise<{ status: number; data: SkipResponse | null; code?: string }>;
  /** `author` — сотрудник, поставивший итог (из записи outbox, а не из страницы). */
  sendOutcome(request: OutcomeRequest, author: string): Promise<SendResult>;
  /** Итог «Договорились — записать»: ответ нужен мастеру целиком (запись, свободные даты). Нет сети — исключение. */
  postOutcome(request: OutcomeRequest): Promise<{ status: number; json: unknown }>;
  /** Сводка «Сегодня» с сервера; нет сети — статус 0. `wrong_user` — как у очереди. */
  today(): Promise<{ status: number; data: TodaySummary | null; code?: string }>;
}

/** Заголовок автора итога и пропуска (D-291); имя совпадает с AUTHOR_HEADER маршрутов. */
export const AUTHOR_HEADER = 'X-Call-Author';

/** `author` — сотрудник этой страницы: им подписываются чтения, пропуск и итог с записью; итоги outbox — своим автором. */
export function createCallApi(headers: HeaderFactory, author: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): CallApi {
  const base = { cache: 'no-store' as const, credentials: 'same-origin' as const };
  return {
    async queue({ limit, exclude, group, signal }) {
      const qs = new URLSearchParams({ limit: String(limit), group });
      if (exclude.length > 0) qs.set('exclude', exclude.slice(0, 50).join(','));
      const res = await fetchImpl(`/api/calls/queue?${qs}`, { ...base, headers: { ...headers(), [AUTHOR_HEADER]: author }, signal });
      if (res.ok) return { status: res.status, data: (await res.json()) as QueueResponse };
      return { status: res.status, data: null, code: await codeOf(res) };
    },
    async skip(body) {
      const res = await fetchImpl('/api/calls/skips', { ...base, method: 'POST', headers: { ...headers(), [AUTHOR_HEADER]: author, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) return { status: res.status, data: (await res.json()) as SkipResponse };
      return { status: res.status, data: null, code: await codeOf(res) };
    },
    async sendOutcome(request, by) {
      const res = await fetchImpl('/api/calls/outcomes', { ...base, method: 'POST', headers: { ...headers(), [AUTHOR_HEADER]: by, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: res.status, ...(res.ok ? {} : { code: await codeOf(res) }) };
    },
    async postOutcome(request) {
      const res = await fetchImpl('/api/calls/outcomes', { ...base, method: 'POST', headers: { ...headers(), [AUTHOR_HEADER]: author, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async today() {
      try {
        const res = await fetchImpl('/api/calls/today', { ...base, headers: { ...headers(), [AUTHOR_HEADER]: author } });
        if (res.ok) return { status: res.status, data: (await res.json()) as TodaySummary };
        return { status: res.status, data: null, code: await codeOf(res) };
      } catch {
        return { status: 0, data: null };
      }
    },
  };
}
