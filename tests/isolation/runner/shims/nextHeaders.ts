// Подмена next/headers для прогона изоляции: cookies() и headers() читают область запроса, которую
// раннер открывает вокруг каждого вызова маршрута, страницы или действия (AsyncLocalStorage).
import { AsyncLocalStorage } from 'node:async_hooks';

type Scope = { headers: Headers; jar: Map<string, string> };
const als = new AsyncLocalStorage<Scope>();

/** Выполнить fn «внутри запроса»: заголовки и cookie видны подмене next/headers. */
export function withRequestScope<T>(init: { headers?: HeadersInit; cookies?: Record<string, string> }, fn: () => Promise<T>): Promise<T> {
  const scope: Scope = { headers: new Headers(init.headers), jar: new Map(Object.entries(init.cookies ?? {})) };
  return als.run(scope, fn);
}

const scope = (): Scope => als.getStore() ?? { headers: new Headers(), jar: new Map() };

type CookieEntry = { name: string; value: string };

export async function cookies() {
  const { jar } = scope();
  const all = (): CookieEntry[] => [...jar].map(([name, value]) => ({ name, value }));
  return {
    get: (name: string): CookieEntry | undefined => (jar.has(name) ? { name, value: jar.get(name) ?? '' } : undefined),
    getAll: all,
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => {
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
    toString: () => all().map((c) => `${c.name}=${c.value}`).join('; '),
    get size() {
      return jar.size;
    },
  };
}

export async function headers(): Promise<Headers> {
  return scope().headers;
}

export async function draftMode() {
  return { isEnabled: false, enable() {}, disable() {} };
}
