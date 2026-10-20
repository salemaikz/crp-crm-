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
  const self = {
    location: { origin: 'https://crm.test' },
    addEventListener: (type: string, fn: Listener) => void listeners.set(type, fn),
    skipWaiting: () => undefined,
    clients: { claim: async () => undefined },
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (k: string) => stores.delete(k),
    open: async (k: string) => {
      const m = stores.get(k) ?? new Map<string, unknown>();
      stores.set(k, m);
      return { match: async (r: { url?: string } | string) => m.get(typeof r === 'string' ? r : (r.url ?? '')), put: async (r: { url?: string } | string, v: unknown) => void m.set(typeof r === 'string' ? r : (r.url ?? ''), v) };
    },
  };
  const fetchFn = async (r: { url: string }) => {
    fetched.push(r.url);
    return { ok: true, redirected: false, clone() { return this; } };
  };
  vm.runInNewContext(readFileSync(join(ROOT, 'public', 'sw.js'), 'utf8'), { self, caches, fetch: fetchFn, URL, Promise });
  void cache;
  return { listeners, fetched, stores };
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
  const names = [...w.stores.get('crm-shell-v1')!.keys()];
  assert.ok(names.includes('/call'), 'оболочка сохранена');
  assert.ok(!names.some((n) => n.includes('/api/')), 'в кэше нет API');
});

test('SW очищает кэш по команде выхода', async () => {
  const w = loadWorker();
  const fetchHandler = w.listeners.get('fetch')!;
  const nav = fetchEvent('https://crm.test/call', { mode: 'navigate' });
  fetchHandler(nav.e);
  await nav.responded();
  assert.ok(w.stores.has('crm-shell-v1'));
  let waited: Promise<unknown> | null = null;
  w.listeners.get('message')!({ data: { type: 'clear' }, waitUntil: (p: Promise<unknown>) => void (waited = p) });
  await waited;
  assert.equal(w.stores.has('crm-shell-v1'), false);
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
