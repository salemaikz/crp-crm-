// Service worker и доска (pipeline-v2 §9.1): оболочка /board в кэше версии v4 с теми же правилами очистки, данные доски не кэшируются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..', '..', '..');
type Listener = (e: unknown) => void;

function loadWorker() {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, unknown>>();
  const net = { down: false };
  const self = {
    location: { origin: 'https://crm.test' },
    addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const key = (r: { url?: string } | string) => (typeof r === 'string' ? r : (r.url ?? ''));
  const caches = {
    keys: async () => [...stores.keys()],
    has: async (k: string) => stores.has(k),
    delete: async (k: string) => stores.delete(k),
    open: async (k: string) => {
      const m = stores.get(k) ?? new Map<string, unknown>();
      stores.set(k, m);
      return { delete: async (r: { url?: string } | string) => m.delete(key(r)), match: async (r: { url?: string } | string) => m.get(key(r)), put: async (r: { url?: string } | string, v: unknown) => void m.set(key(r), v) };
    },
  };
  const fetchFn = async () => {
    if (net.down) throw new Error('offline');
    return { ok: true, redirected: false, status: 200, statusText: 'OK', headers: new Headers(), text: async () => '<html><head></head><body>оболочка</body></html>', clone() { return this; } };
  };
  vm.runInNewContext(readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8'), { self, caches, fetch: fetchFn, URL, Promise, Headers, Response });
  return { listeners, stores, net };
}

function ev(url: string, init: { method?: string; mode?: string } = {}) {
  let responded: Promise<unknown> | null = null;
  return { e: { request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'navigate' }, respondWith: (p: Promise<unknown>) => void (responded = p) }, responded: () => responded };
}

test('кэш оболочки — версия v4, оболочки /call и /board лежат в нём отдельно', async () => {
  const w = loadWorker();
  const h = w.listeners.get('fetch')!;
  for (const path of ['/call', '/board']) {
    const nav = ev(`https://crm.test${path}`);
    h(nav.e);
    await nav.responded();
  }
  assert.deepEqual([...w.stores.keys()], ['crm-shell-v4']);
  assert.deepEqual([...w.stores.get('crm-shell-v4')!.keys()].sort(), ['/board', '/call']);
});

test('без сети /board отдаётся из кэша с меткой «из кэша»', async () => {
  const w = loadWorker();
  const h = w.listeners.get('fetch')!;
  const online = ev('https://crm.test/board');
  h(online.e);
  await online.responded();
  w.net.down = true;
  const off = ev('https://crm.test/board');
  h(off.e);
  const res = (await off.responded()) as Response;
  assert.match(await res.text(), /<head><meta name="crm-shell" content="stale">/);
});

test('данные доски (/api/cards/board) мимо кэша: ПДн на телефоне не копятся', () => {
  const w = loadWorker();
  const h = w.listeners.get('fetch')!;
  for (const url of ['https://crm.test/api/cards/board?q=a', 'https://crm.test/api/cards/board/column?column=new&cursor=x']) {
    const r = ev(url, { mode: 'cors' });
    h(r.e);
    assert.equal(r.responded(), null, url);
  }
});

test('вход и выход стирают обе оболочки: следующий сотрудник без сети не получит доску прежнего', async () => {
  for (const trigger of [ev('https://crm.test/login'), ev('https://crm.test/api/auth/logout', { method: 'POST', mode: 'cors' })]) {
    const w = loadWorker();
    const h = w.listeners.get('fetch')!;
    for (const path of ['/call', '/board']) {
      const nav = ev(`https://crm.test${path}`);
      h(nav.e);
      await nav.responded();
    }
    let waited: Promise<unknown> | null = null;
    h({ ...trigger.e, waitUntil: (p: Promise<unknown>) => void (waited = p) });
    await waited;
    w.net.down = true;
    const off = ev('https://crm.test/board');
    h(off.e);
    await assert.rejects(Promise.resolve(off.responded()));
  }
});

test('выход не завершён: оболочка /board не отдаётся из кэша и не кэшируется заново', async () => {
  const w = loadWorker();
  const h = w.listeners.get('fetch')!;
  const first = ev('https://crm.test/board');
  h(first.e);
  await first.responded();
  w.stores.set('crm-logout-pending', new Map());
  w.stores.get('crm-shell-v4')!.clear();
  const online = ev('https://crm.test/board');
  h(online.e);
  await online.responded();
  assert.equal(w.stores.get('crm-shell-v4')!.has('/board'), false);
  w.stores.get('crm-shell-v4')!.set('/board', { text: async () => '<html><head></head></html>', headers: new Headers(), status: 200, statusText: 'OK' });
  w.net.down = true;
  const off = ev('https://crm.test/board');
  h(off.e);
  await assert.rejects(Promise.resolve(off.responded()));
});

test('старые версии кэша (v3) удаляются при активации', async () => {
  const w = loadWorker();
  w.stores.set('crm-shell-v3', new Map());
  let waited: Promise<unknown> | null = null;
  w.listeners.get('activate')!({ waitUntil: (p: Promise<unknown>) => void (waited = p) });
  await waited;
  assert.equal(w.stores.has('crm-shell-v3'), false);
});
