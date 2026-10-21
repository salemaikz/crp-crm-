// «Выход не завершён» (D-063): флаг до запроса выхода, скрипт в <head> прячет страницу, повтор до ответа сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  clearLogoutPending,
  completePendingLogout,
  isLogoutPending,
  LOGOUT_GUARD_SCRIPT,
  LOGOUT_MARKER_COOKIE,
  LOGOUT_PENDING_ATTR,
  LOGOUT_PENDING_KEY,
  markLogoutPending,
  postLogout,
} from '../../../src/ui/call/logoutPending';

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

function runScript(storage: { getItem(k: string): string | null } | null) {
  const attrs = new Map<string, string>();
  const localStorage = storage ?? {
    getItem: () => {
      throw new Error('SecurityError');
    },
  };
  vm.runInNewContext(LOGOUT_GUARD_SCRIPT, { localStorage, document: { documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v) } } });
  return attrs;
}

test('флаг без ПДн: ставится, читается, снимается', () => {
  const s = mem();
  assert.equal(isLogoutPending(s), false);
  assert.equal(markLogoutPending(s), true);
  assert.deepEqual([...s.m.entries()], [[LOGOUT_PENDING_KEY, '1']]);
  assert.equal(isLogoutPending(s), true);
  clearLogoutPending(s);
  assert.equal(isLogoutPending(s), false);
  assert.equal(isLogoutPending(null), false);
});

test('скрипт в <head>: флаг стоит — страница прячется до отрисовки; нет флага или хранилища — ничего', () => {
  const s = mem();
  assert.equal(runScript(s).has(LOGOUT_PENDING_ATTR), false);
  markLogoutPending(s);
  assert.equal(runScript(s).has(LOGOUT_PENDING_ATTR), true);
  assert.equal(runScript(null).size, 0, 'запрет хранилища не роняет страницу');
});

test('запрос выхода: 2xx и 401 — сессии нет; 5xx, 403 и сеть — повторить', async () => {
  const reply = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
  assert.equal(await postLogout(reply(204)), true);
  assert.equal(await postLogout(reply(401)), true);
  assert.equal(await postLogout(reply(503)), false);
  assert.equal(await postLogout(reply(403)), false);
  assert.equal(await postLogout((async () => Promise.reject(new Error('offline'))) as unknown as typeof fetch), false);
});

test('довести выход: без сети флаг остаётся; ответ сервера — уборка и флаг снят; без флага — ничего не шлём', async () => {
  const s = mem();
  markLogoutPending(s);
  const calls: string[] = [];
  const deps = (ok: boolean) => ({
    storage: s,
    post: async () => (calls.push('post'), ok),
    cleanup: async () => void calls.push('cleanup'),
  });
  assert.equal(await completePendingLogout(deps(false)), false);
  assert.equal(isLogoutPending(s), true);
  assert.equal(await completePendingLogout(deps(true)), true);
  assert.equal(isLogoutPending(s), false);
  assert.deepEqual(calls, ['post', 'post', 'cleanup']);
  assert.equal(await completePendingLogout(deps(true)), true);
  assert.equal(calls.length, 3, 'флага нет — запроса нет');
});

/** Записи document.cookie в контексте скрипта или страницы. */
function cookieJar(protocol: string) {
  const writes: string[] = [];
  const document = {
    documentElement: { setAttribute: () => undefined },
    set cookie(v: string) {
      writes.push(v);
    },
    get cookie() {
      return '';
    },
  };
  return { writes, document, location: { protocol } };
}

test('метка для сервера (D-310): скрипт в <head> ставит её, пока стоит флаг; Secure только на https; без ПДн', () => {
  const s = mem();
  const none = cookieJar('https:');
  vm.runInNewContext(LOGOUT_GUARD_SCRIPT, { localStorage: s, ...none });
  assert.deepEqual(none.writes, [], 'нет флага — нет метки');
  s.setItem(LOGOUT_PENDING_KEY, '1');
  const https = cookieJar('https:');
  vm.runInNewContext(LOGOUT_GUARD_SCRIPT, { localStorage: s, ...https });
  assert.equal(https.writes.length, 1);
  assert.match(https.writes[0]!, new RegExp(`^${LOGOUT_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=\\d+; Secure$`));
  const http = cookieJar('http:');
  vm.runInNewContext(LOGOUT_GUARD_SCRIPT, { localStorage: s, ...http });
  assert.match(http.writes[0]!, /SameSite=Strict; Max-Age=\d+$/);
});

test('метка для сервера (D-310): флаг ставит её первой, даже без хранилища; снятие флага стирает её', () => {
  const g = globalThis as { document?: unknown; location?: unknown };
  const jar = cookieJar('http:');
  g.document = jar.document;
  g.location = jar.location;
  try {
    assert.equal(markLogoutPending(null), false, 'хранилища нет');
    assert.match(jar.writes[0]!, new RegExp(`^${LOGOUT_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=[1-9]\\d*$`), 'метка всё равно стоит');
    clearLogoutPending(mem());
    assert.match(jar.writes[1]!, new RegExp(`^${LOGOUT_MARKER_COOKIE}=1; Path=/; SameSite=Strict; Max-Age=0$`));
  } finally {
    delete g.document;
    delete g.location;
  }
});
