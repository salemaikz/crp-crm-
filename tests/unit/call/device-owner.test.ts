// Общий телефон (D-291): при загрузке под B данные A удаляются или обезличиваются; итоги A остаются без названий.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPageSession, createExpiredReporter, DEVICE_OWNER_KEY, expiredForeign, foreignKeys, markDeviceOwner, ownerChanged, sanitizeForeign, type ScanStorage } from '../../../src/ui/call/deviceOwner';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';

function mem(): ScanStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const entry = (opId: string, userId: string, title: string) => ({
  opId, userId, notBefore: 0, attempts: 0, retryAt: 0, createdAt: 1, title, kind: 'no_answer' as const,
  request: { opId, cardId: `cd-${opId}`, outcomeKey: 'no_answer' } as never,
});

test('ключи других сотрудников: только pending и tally чужих, свои и посторонние ключи не трогаются', () => {
  const s = mem();
  for (const k of ['crm.call.pending.uA', 'crm.call.tally.uA', 'crm.call.pending.uB', 'crm.call.tally.uB', 'crm.logout.pending', 'other']) s.setItem(k, '1');
  assert.deepEqual(foreignKeys(s, 'uB').sort(), ['crm.call.pending.uA', 'crm.call.tally.uA']);
});

test('вход B после истёкшей сессии A: черновик, счётчик и отказы A удалены, итоги A — без названия, но целы', async () => {
  const storage = mem();
  storage.setItem('crm.call.pending.uA', '{"call":{"title":"ТОО Синтетик"}}');
  storage.setItem('crm.call.tally.uA', '{"day":"x","items":[]}');
  storage.setItem('crm.call.tally.uB', '{"day":"x","items":[]}');
  const store = createMemoryStore();
  await store.put(entry('a1', 'uA', 'ТОО Синтетик'));
  await store.put(entry('b1', 'uB', 'ТОО Свой'));
  await store.putRejected({ opId: 'ra', userId: 'uA', title: 'ТОО Синтетик', code: 'not_found', at: 1 });
  await store.putRejected({ opId: 'rb', userId: 'uB', title: 'ТОО Свой', code: 'not_found', at: 1 });

  await sanitizeForeign('uB', { storage, store });

  assert.deepEqual([...storage.m.keys()], ['crm.call.tally.uB']);
  const a = await store.all('uA');
  assert.equal(a.length, 1);
  assert.equal(a[0]!.title, '');
  assert.equal((a[0]!.request as { cardId: string }).cardId, 'cd-a1');
  assert.equal((await store.all('uB'))[0]!.title, 'ТОО Свой', 'свои данные B не трогаются');
  assert.equal((await store.rejected('uA')).length, 0);
  assert.equal((await store.rejected('uB')).length, 1);
});

test('нет хранилищ — уборка не бросает', async () => {
  await sanitizeForeign('uB', { storage: null, store: null });
});

test('метка владельца телефона (D-292): страница сотрудника, которого на телефоне сменили, устарела', () => {
  const s = mem();
  assert.equal(ownerChanged(s, 'uA'), false, 'метки нет — решает сервер');
  markDeviceOwner(s, 'uA');
  assert.equal(s.getItem(DEVICE_OWNER_KEY), 'uA');
  assert.equal(ownerChanged(s, 'uA'), false);
  markDeviceOwner(s, 'uB');
  assert.equal(ownerChanged(s, 'uA'), true, 'вкладка A после входа B');
  assert.equal(ownerChanged(s, 'uB'), false);
  assert.deepEqual(foreignKeys(s, 'uB'), [], 'метка — не данные сотрудника, уборка её не трогает');
  assert.equal(ownerChanged(null, 'uA'), false);
});

test('метка владельца: хранилище бросает — не падаем', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => undefined };
  markDeviceOwner(broken, 'uA');
  assert.equal(ownerChanged(broken, 'uA'), false);
});

// ---- Срок итогов другого сотрудника (D-293 п. 2) и сверка сессии вкладки (D-292) ---------------------------------

const HOUR = 3_600_000;
const NOW = 1_000 * HOUR;
const TTL = 72 * HOUR;
const withText = (opId: string, userId: string, createdAt: number, freeText: boolean | undefined, note = 'Заметка Синтетик') => ({
  ...entry(opId, userId, ''),
  createdAt,
  ...(freeText === undefined ? {} : { freeText }),
  request: { opId, cardId: `cd-${opId}`, outcomeKey: 'no_answer', note, lprInfo: null, fields: {}, agreement: null } as never,
});

test('срок: удаляются только чужие итоги со свободным текстом старше срока; свои, свежие и без текста — нет', () => {
  const entries = [
    withText('old', 'uA', NOW - TTL, true),
    withText('old-legacy', 'uA', NOW - TTL - 1, undefined),
    withText('fresh', 'uA', NOW - TTL + 1, true),
    withText('bare', 'uA', NOW - 2 * TTL, false, ''),
    withText('mine', 'uB', NOW - 2 * TTL, true),
    withText('c-old', 'uC', NOW - 3 * TTL, true),
  ];
  const got = expiredForeign(entries, 'uB', NOW, TTL);
  assert.deepEqual([...got.entries()], [['uA', ['old', 'old-legacy']], ['uC', ['c-old']]]);
});

test('срок: сначала журнал на сервере, потом удаление; сервер не ответил — итог остаётся до следующей загрузки', async () => {
  const store = createMemoryStore();
  await store.put(withText('old', 'uA', NOW - TTL - 1, true));
  await store.put(withText('fresh', 'uA', NOW - 1, true));
  const calls: Array<[string, string[]]> = [];
  await sanitizeForeign('uB', { storage: null, store, expire: { now: NOW, ttlMs: TTL, report: async (a, ids) => (calls.push([a, ids]), false) } });
  assert.deepEqual(calls, [['uA', ['old']]]);
  assert.deepEqual((await store.allExcept('uB')).map((e) => e.opId).sort(), ['fresh', 'old'], 'без ответа сервера не удаляем');

  await sanitizeForeign('uB', { storage: null, store, expire: { now: NOW, ttlMs: TTL, report: async () => true } });
  assert.deepEqual((await store.allExcept('uB')).map((e) => e.opId), ['fresh']);
  // Отчёт бросил — тоже не удаляем
  await store.put(withText('old2', 'uA', NOW - TTL - 1, true));
  await sanitizeForeign('uB', { storage: null, store, expire: { now: NOW, ttlMs: TTL, report: async () => { throw new Error('net'); } } });
  assert.ok(await store.get('old2'));
});

test('срок: сообщение о потере — POST /api/device/outbox-expired с id устройства, только id без ПДн', async () => {
  const store = createMemoryStore();
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const ok = createExpiredReporter(store, (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response('{}', { status: 200 }))) as never);
  assert.equal(await ok('uA', ['op-1']), true);
  assert.equal(seen[0]!.url, '/api/device/outbox-expired');
  assert.equal(seen[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { authorId: 'uA', opIds: ['op-1'] });
  assert.match((seen[0]!.init.headers as Record<string, string>)['X-Device-Id']!, /^[A-Za-z0-9_-]{1,64}$/);
  const locked = createExpiredReporter(store, (async () => new Response('{}', { status: 423 })) as never);
  assert.equal(await locked('uA', ['op-1']), false);
  const offline = createExpiredReporter(store, (async () => { throw new TypeError('Failed to fetch'); }) as never);
  assert.equal(await offline('uA', ['op-1']), false);
});

test('сверка сессии вкладки: 200 — та же, 409 — вошёл другой, 401 — сессии нет, сеть и прочее — неизвестно', async () => {
  const at = (status: number) => (async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/device/session');
    assert.equal((init.headers as Record<string, string>)['X-Call-Author'], 'uA');
    return new Response('{}', { status });
  }) as never;
  assert.equal(await checkPageSession('uA', at(200)), 'same');
  assert.equal(await checkPageSession('uA', at(409)), 'other');
  assert.equal(await checkPageSession('uA', at(401)), 'gone');
  assert.equal(await checkPageSession('uA', at(500)), 'unknown');
  assert.equal(await checkPageSession('uA', (async () => { throw new TypeError('Failed to fetch'); }) as never), 'unknown');
});
