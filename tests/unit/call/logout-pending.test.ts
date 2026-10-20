// «Выход не завершён» (D-063): флаг до запроса выхода, скрипт в <head> прячет страницу, повтор до ответа сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  clearLogoutPending,
  completePendingLogout,
  isLogoutPending,
  LOGOUT_GUARD_SCRIPT,
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
