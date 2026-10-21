// Клиент API Wazzup v3. Только хост api.wazzup24.com (createHttp режет остальное), `Authorization: Bearer <ключ>`,
// таймаут 10 с; 429 и 5xx — один повтор через 1 с, дальше код. Тела ответов и ключ не логируются и в ошибки не идут.
import type { HealthCode, MessengerChannelInfo, PluginHttp } from '../../contract';
import { PluginHttpError } from '../../http';
import { WAZZUP_API_BASE } from './types';

export type ApiFailure = 'auth' | 'provider_down' | 'rejected';
type ApiResult<T> = { ok: true; data: T } | { ok: false; code: ApiFailure };

/** Полный объект подписок: Wazzup заменяет подписки целиком, поэтому каждое поле задаём явно. */
export const WEBHOOK_SUBSCRIPTIONS = { messagesAndStatuses: true, channelsUpdates: true, contactsAndDealsCreation: false, templateStatus: false } as const;

export interface WazzupApiOptions {
  /** Пауза перед единственным повтором; в тестах 0. */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function failureOf(status: number): ApiFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status >= 500) return 'provider_down';
  return 'rejected';
}

export function createWazzupApi(http: PluginHttp, apiKey: string, opts: WazzupApiOptions = {}) {
  const delay = opts.retryDelayMs ?? 1000;

  async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const init = {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await http.fetch(`${WAZZUP_API_BASE}${path}`, init);
      } catch (e) {
        // Хост вне списка — наша ошибка конфигурации, а не отказ провайдера
        if (e instanceof PluginHttpError) return { ok: false, code: 'rejected' };
        if (attempt === 0) {
          await sleep(delay);
          continue;
        }
        return { ok: false, code: 'provider_down' };
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          await sleep(delay);
          continue;
        }
        return { ok: false, code: 'provider_down' };
      }
      if (!res.ok) return { ok: false, code: failureOf(res.status) };
      const text = await res.text().catch(() => '');
      if (text === '') return { ok: true, data: undefined as T };
      try {
        return { ok: true, data: JSON.parse(text) as T };
      } catch {
        return { ok: false, code: 'rejected' };
      }
    }
    return { ok: false, code: 'provider_down' };
  }

  return {
    /** Каналы компании (удалённые отбрасываются). */
    async getChannels(): Promise<ApiResult<MessengerChannelInfo[]>> {
      const r = await call<unknown>('GET', '/channels');
      if (!r.ok) return r;
      if (!Array.isArray(r.data)) return { ok: false, code: 'rejected' };
      const channels: MessengerChannelInfo[] = [];
      for (const c of r.data as Record<string, unknown>[]) {
        if (!c || typeof c.guid !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(c.guid) || c.deleted === true) continue;
        channels.push({
          channelRef: c.guid,
          transport: typeof c.transport === 'string' ? c.transport.slice(0, 32) : 'unknown',
          plainId: typeof c.plainId === 'string' && c.plainId !== '' ? c.plainId.slice(0, 64) : null,
          state: typeof c.state === 'string' ? c.state.toLowerCase().slice(0, 64) : 'unknown',
        });
      }
      return { ok: true, data: channels };
    },
    async patchWebhooks(webhooksUri: string): Promise<ApiResult<void>> {
      return call<void>('PATCH', '/webhooks', { webhooksUri, subscriptions: WEBHOOK_SUBSCRIPTIONS });
    },
    /** Сотрудники: только id и имя (телефон нужен лишь мобильному приложению Wazzup, его не передаём). */
    async postUsers(users: readonly { id: string; name: string }[]): Promise<ApiResult<void>> {
      return call<void>('POST', '/users', users.map((u) => ({ id: u.id, name: u.name })));
    },
    /** Одноразовая ссылка окна чата. Имя клиента не передаётся (D-270). */
    async postIframe(input: { user: { id: string; name: string }; chatType: string; chatId: string; channelId: string | null }): Promise<ApiResult<{ link: string }>> {
      const r = await call<{ link?: unknown }>('POST', '/iframe', {
        user: { id: input.user.id, name: input.user.name },
        scope: 'card',
        filter: [{ chatType: input.chatType, chatId: input.chatId }],
        ...(input.channelId ? { activeChat: { channelId: input.channelId, chatType: input.chatType, chatId: input.chatId } } : {}),
        options: { useDealsEvents: false, useMessageEvents: false },
      });
      if (!r.ok) return r;
      const link = r.data?.link;
      return typeof link === 'string' ? { ok: true, data: { link } } : { ok: false, code: 'rejected' };
    },
  };
}

export const toHealth = (code: ApiFailure): HealthCode => (code === 'rejected' ? 'provider_down' : code);
