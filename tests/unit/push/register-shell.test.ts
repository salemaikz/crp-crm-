// Регистрация service worker оболочкой любой роли (P8b): без неё на /account push недоступен (`serviceWorker.ready` висит).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerShell } from '@/ui/call/serviceWorker';

const env = process.env as Record<string, string | undefined>;
const was = env['NODE_ENV'];
afterEach(() => {
  env['NODE_ENV'] = was;
  Reflect.deleteProperty(globalThis, 'navigator');
});

function fakeNavigator(register: (url: string, o: { scope: string }) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { register } }, configurable: true, writable: true });
}

test('в production оболочка регистрирует /sw.js и дожидается регистрации', async () => {
  env['NODE_ENV'] = 'production';
  const calls: string[] = [];
  fakeNavigator(async (url, o) => {
    calls.push(`${url}|${o.scope}`);
    return {};
  });
  await registerShell();
  assert.deepEqual(calls, ['/sw.js|/']);
});

test('ошибка регистрации не всплывает; вне production регистрации нет', async () => {
  env['NODE_ENV'] = 'production';
  fakeNavigator(() => Promise.reject(new Error('blocked')));
  await registerShell();
  env['NODE_ENV'] = 'development';
  let called = false;
  fakeNavigator(async () => {
    called = true;
    return {};
  });
  await registerShell();
  assert.equal(called, false);
});

test('регистрацию ставит оболочка (PushSync в AppShell), а не только экраны «Звонить» и «Доска»', () => {
  assert.match(readFileSync('src/ui/shells/AppShell.tsx', 'utf8'), /<PushSync /);
  assert.match(readFileSync('src/ui/push/PushSync.tsx', 'utf8'), /registerShell\(\)/);
});
