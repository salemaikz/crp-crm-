// Service worker и тексты экрана: SW не трогает API и не кэширует данные, ключи экрана есть в локали.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(import.meta.dirname, '..', '..', '..');

type Listener = (e: unknown) => void;

function loadWorker() {
  const listeners = new Map<string, Listener>();
  const cache = new Map<string, unknown>();
  const stores = new Map<string, Map<string, unknown>>();
  const fetched: string[] = [];
  const net = { down: false };
  const self = {
    location: { origin: 'https://crm.test' },
    addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = {
    keys: async () => [...stores.keys()],
    has: async (k: string) => stores.has(k),
    delete: async (k: string) => stores.delete(k),
    open: async (k: string) => {
      const m = stores.get(k) ?? new Map<string, unknown>();
      stores.set(k, m);
      return { delete: async (r: { url?: string } | string) => m.delete(typeof r === 'string' ? r : (r.url ?? '')), match: async (r: { url?: string } | string) => m.get(typeof r === 'string' ? r : (r.url ?? '')), put: async (r: { url?: string } | string, v: unknown) => void m.set(typeof r === 'string' ? r : (r.url ?? ''), v) };
    },
  };
  const fetchFn = async (r: { url: string }) => {
    fetched.push(r.url);
    if (net.down) throw new Error('offline');
    return { ok: true, redirected: false, status: 200, statusText: 'OK', headers: new Headers(), text: async () => '<html><head><title>x</title></head><body>оболочка</body></html>', clone() { return this; } };
  };
  vm.runInNewContext(readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8'), { self, caches, fetch: fetchFn, URL, Promise, Headers, Response });
  void cache;
  return { listeners, fetched, stores, net };
}

function fetchEvent(url: string, init: { method?: string; mode?: string } = {}) {
  let responded: Promise<unknown> | null = null;
  const e = { request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' }, respondWith: (p: Promise<unknown>) => void (responded = p) };
  return { e, responded: () => responded };
}

test('SW не перехватывает API, мутации и чужие адреса: ответы с ПДн не кэшируются', () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch');
  assert.ok(fetchHandler);
  for (const [url, init] of [
    ['https://crm.test/api/calls/queue?limit=4', {}],
    ['https://crm.test/api/calls/outcomes', { method: 'POST' }],
    ['https://crm.test/clients/cl-1', { mode: 'navigate' }],
    ['https://other.test/_next/static/a.js', {}],
  ] as const) {
    const ev = fetchEvent(url, init);
    fetchHandler(ev.e);
    assert.equal(ev.responded(), null, url);
  }
});

test('SW берёт статику сборки и оболочку экрана «Звонить»', async () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch')!;
  const st = fetchEvent('https://crm.test/_next/static/chunks/app.js');
  fetchHandler(st.e);
  assert.ok(st.responded());
  await st.responded();
  const nav = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(nav.e);
  assert.ok(nav.responded());
  await nav.responded();
  const names = [...w.stores.get('crm-shell-v4')!.keys()];
  assert.ok(names.includes('/call'), 'оболочка сохранена');
  assert.ok(!names.some((n) => n.includes('/api/')), 'в кэше нет API');
});

test('SW очищает кэш по команде выхода', async () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch')!;
  const nav = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(nav.e);
  await nav.responded();
  assert.ok(w.stores.has('crm-shell-v4'));
  let waited: Promise<unknown> | null = null;
  w.listeners.get('message')!({ data: { type: 'clear' }, waitUntil: (p: Promise<unknown>) => void (waited = p) });
  await waited;
  assert.equal(w.stores.has('crm-shell-v4'), false);
});

test('без сети оболочка /call отдаётся с меткой «из кэша» (страница не шлёт итоги под чужой сессией)', async () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch')!;
  const online = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(online.e);
  await online.responded();
  w.net.down = true;
  const offline = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(offline.e);
  const res = (await offline.responded()) as Response;
  assert.match(await res.text(), /<head><meta name="crm-shell" content="stale">/);
});

test('вход и выход: оболочка прежнего сотрудника удаляется, следующий без сети её не получит', async () => {
  for (const trigger of [fetchEvent('https://crm.test/login', { mode: 'navigate' }), fetchEvent('https://crm.test/api/auth/logout', { method: 'POST' })]) {
    const w = loadWorker();
    const fetchHandler = w.listeners.get('fetch')!;
    const nav = fetchEvent('https://crm.test/call', { mode: 'navigate' });
    fetchHandler(nav.e);
    await nav.responded();
    let waited: Promise<unknown> | null = null;
    fetchHandler({ ...trigger.e, waitUntil: (p: Promise<unknown>) => void (waited = p) });
    await waited;
    assert.equal(trigger.responded(), null, 'запрос идёт в сеть как обычно');
    w.net.down = true;
    const offline = fetchEvent('https://crm.test/call', { mode: 'navigate' });
    fetchHandler(offline.e);
    await assert.rejects(Promise.resolve(offline.responded()));
  }
});

test('выход не завершён (метка crm-logout-pending): оболочка /call не отдаётся из кэша и не кэшируется заново', async () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch')!;
  const first = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(first.e);
  await first.responded();
  w.stores.set('crm-logout-pending', new Map());
  w.stores.get('crm-shell-v4')!.clear();
  // Сеть есть, сессия прежнего сотрудника ещё жива: страница приходит, но в кэш не ложится
  const online = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(online.e);
  await online.responded();
  assert.equal(w.stores.get('crm-shell-v4')!.has('/call'), false);
  // Оболочка из кэша (положена до выхода) без сети не отдаётся
  w.stores.get('crm-shell-v4')!.set('/call', { text: async () => '<html><head></head></html>', headers: new Headers(), status: 200, statusText: 'OK' });
  w.net.down = true;
  const offline = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(offline.e);
  await assert.rejects(Promise.resolve(offline.responded()));
  // Выход завершён — метка снята, кэшированная оболочка снова доступна без сети
  w.stores.delete('crm-logout-pending');
  const after = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(after.e);
  assert.ok(await after.responded());
});

function flat(tree: Record<string, unknown>, prefix = '', out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(tree)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flat(v as Record<string, unknown>, p, out);
    else out.add(p);
  }
  return out;
}

test('все статические ключи t(...) экрана «Звонить» есть в messages/ru/call.json', () => {
  const keys = flat(JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', 'call.json'), 'utf8')) as Record<string, unknown>);
  const dir = join(ROOT, 'src', 'ui', 'call');
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)) if (!keys.has(m[1] as string)) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('динамические ключи: группы очереди, виды карточки, сообщения «не хватает» заведены', () => {
  const keys = flat(JSON.parse(readFileSync(join(ROOT, 'messages', 'ru', 'call.json'), 'utf8')) as Record<string, unknown>);
  for (const k of ['groups.all', 'groups.callbacks', 'groups.retries', 'groups.new', 'card.group.callbacks', 'card.group.retries', 'card.group.returns', 'card.group.new']) assert.ok(keys.has(k), k);
  for (const m of ['lpr', 'lprInfo', 'reason', 'reasonText', 'callbackAt', 'phone', 'field']) assert.ok(keys.has(`sheet.missing.${m}`), m);
});
