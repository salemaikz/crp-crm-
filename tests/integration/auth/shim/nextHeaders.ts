// Подмена next/headers для тестов cookie сессии: область запроса (AsyncLocalStorage), запись всех
// cookies().set с параметрами и режим «серверный компонент», где Next запрещает менять cookie.
import { AsyncLocalStorage } from 'node:async_hooks';

export type CookieSet = { name: string; value: string; maxAge?: number };
type Scope = { headers: Headers; jar: Map<string, string>; sets: CookieSet[]; readOnly: boolean };
const als = new AsyncLocalStorage<Scope>();

/** Выполнить fn «внутри запроса». readOnly — как серверный компонент: set() бросает, как в Next. */
export async function inRequest<T>(
  init: { headers?: Record<string, string>; cookies?: Record<string, string>; readOnly?: boolean },
  fn: () => Promise<T>,
): Promise<{ result: T; sets: CookieSet[] }> {
  const scope: Scope = {
    headers: new Headers(init.headers),
    jar: new Map(Object.entries(init.cookies ?? {})),
    sets: [],
    readOnly: init.readOnly ?? false,
  };
  const result = await als.run(scope, fn);
  return { result, sets: scope.sets };
}

function scope(): Scope {
  const s = als.getStore();
  if (!s) throw new Error('`cookies` was called outside a request scope');
  return s;
}

export async function cookies() {
  const s = scope();
  return {
    get: (name: string) => (s.jar.has(name) ? { name, value: s.jar.get(name) ?? '' } : undefined),
    has: (name: string) => s.jar.has(name),
    set: (name: string, value: string, opts: { maxAge?: number } = {}) => {
      if (s.readOnly) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
      s.sets.push({ name, value, maxAge: opts.maxAge });
      if (opts.maxAge === 0) s.jar.delete(name);
      else s.jar.set(name, value);
    },
  };
}

export async function headers(): Promise<Headers> {
  return scope().headers;
}
