// HTTP наружу для плагинов (INTEGRATIONS §8): только https и только хосты своего провайдера, таймаут, без
// переходов по редиректам (иначе ответ мог бы увести запрос на чужой хост). Ничего не логирует: ни адрес, ни тело.
import type { PluginHttp } from './contract';

export const PLUGIN_HTTP_TIMEOUT_MS = 10_000;

/** Ошибка без подробностей: код, без адреса и тела. */
export class PluginHttpError extends Error {
  override name = 'PluginHttpError';
  constructor(readonly code: 'host_not_allowed') {
    super(code);
  }
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export function createHttp(allowedHosts: readonly string[], fetchImpl: FetchImpl = (u, i) => globalThis.fetch(u, i)): PluginHttp {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return {
    fetch: async (url, init) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new PluginHttpError('host_not_allowed');
      }
      if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || !allowed.has(u.hostname.toLowerCase())) {
        throw new PluginHttpError('host_not_allowed');
      }
      const { timeoutMs, signal, ...rest } = init;
      const timeout = AbortSignal.timeout(timeoutMs ?? PLUGIN_HTTP_TIMEOUT_MS);
      return fetchImpl(u.toString(), { ...rest, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    },
  };
}
