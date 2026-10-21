// Метка «выход не завершён» (D-310): телефон ставит не-httpOnly cookie при «Всё равно выйти» без сети. Сервер видит её
// на любом запросе с сессией — route(), page(), action() — и закрывает сессию по cookie в БД, стирает cookie сессии и
// метку; ответ — как без сессии. Метку снимает вход (новая cookie сессии) и выход. Сессия читается настоящим
// getSession(): cookie → sessions → users, next/headers — подмена с записью.
import { register } from 'node:module';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestDb } from '../../../src/server/platform/db/testing';

register('./shim/hooks.mjs', import.meta.url);

const { inRequest } = await import('./shim/nextHeaders');
const { action, page, route } = await import('../../../src/server/access/wrappers');
const { overrideAccessForTests } = await import('../../../src/server/access/testing');
const { getSession, createSession } = await import('../../../src/server/platform/auth/session');
const { LOGOUT_MARKER_COOKIE, SESSION_COOKIE_PLAIN } = await import('../../../src/server/platform/auth/cookie');
const { LOGOUT_MARKER_COOKIE: UI_MARKER } = await import('../../../src/ui/call/logoutPending');
const { setSessionCookie } = await import('../../../src/server/platform/http/sessionCookie');
const { DEFAULT_SECURITY_POLICY } = await import('../../../src/server/platform/auth/types');
const { U } = await import('../../isolation/harness/seed');
const { closeWorld, openWorld } = await import('../access/world');

const ORIGIN = 'http://crm.test';
let db: TestDb;

before(async () => {
  db = await openWorld();
  overrideAccessForTests({ session: getSession });
  await db.sql`UPDATE users SET password_hash = 'синтетический-хеш' WHERE id IN (${U.opA}, ${U.rop})`;
});
after(() => closeWorld(db));

async function freshSession(userId: string): Promise<{ token: string; id: string }> {
  const s = await createSession(db.sql, { userId, policy: DEFAULT_SECURITY_POLICY, nowMs: Date.now() });
  return { token: s.token, id: s.sessionId };
}
const alive = async (id: string) => (await db.sql`SELECT 1 FROM sessions WHERE id = ${id}`).length === 1;
const ctx = { params: Promise.resolve({}) };
const get = () => new Request(`${ORIGIN}/api/calls/queue`);
const withMarker = (token: string) => ({ [SESSION_COOKIE_PLAIN]: token, [LOGOUT_MARKER_COOKIE]: '1' });
const expired = (sets: { name: string; maxAge?: number }[], name: string) => sets.some((c) => c.name === name && c.maxAge === 0);

test('имя метки одно у телефона и у сервера', () => {
  assert.equal(UI_MARKER, LOGOUT_MARKER_COOKIE);
});

test('route() с меткой: 401 без данных, сессии в БД нет, cookie сессии и метка стёрты', async () => {
  const s = await freshSession(U.opA);
  let ran = false;
  const h = route({ perm: 'authenticated' }, async () => {
    ran = true;
    return { secret: 'данные' };
  });
  const r = await inRequest({ cookies: withMarker(s.token) }, () => h(get(), ctx));
  assert.equal(r.result.status, 401);
  assert.deepEqual(await r.result.json(), { error: 'unauthorized' });
  assert.equal(ran, false, 'обработчик не вызван');
  assert.equal(await alive(s.id), false, 'сессия закрыта на сервере');
  assert.ok(expired(r.sets, SESSION_COOKIE_PLAIN), 'cookie сессии стёрта');
  assert.ok(expired(r.sets, LOGOUT_MARKER_COOKIE), 'метка стёрта');
  // Тот же токен без метки больше не работает
  const again = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => h(get(), ctx));
  assert.equal(again.result.status, 401);
});

test('page() с меткой (серверный компонент, cookie менять нельзя): переход на вход, сессии в БД нет', async () => {
  const s = await freshSession(U.opA);
  const p = page({ perm: 'authenticated' }, async () => 'разметка с данными');
  const r = await inRequest({ cookies: withMarker(s.token), readOnly: true }, () =>
    p({}).then(
      () => 'rendered',
      (e: unknown) => String((e as { digest?: unknown }).digest ?? e),
    ),
  );
  assert.match(r.result, /NEXT_REDIRECT.*\/login/);
  assert.equal(await alive(s.id), false);
});

test('action() с меткой: unauthorized, сессии нет', async () => {
  const s = await freshSession(U.rop);
  const act = action({ perm: 'authenticated' }, async () => 'сделано');
  const r = await inRequest({ headers: { host: 'crm.test', origin: ORIGIN }, cookies: withMarker(s.token) }, () => act());
  assert.deepEqual(r.result, { ok: false, error: 'unauthorized' });
  assert.equal(await alive(s.id), false);
});

test('без метки сессия работает; вход (новая cookie сессии) снимает метку', async () => {
  const s = await freshSession(U.opA);
  const h = route({ perm: 'authenticated' }, async ({ viewer }) => ({ who: viewer.userId }));
  const ok = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => h(get(), ctx));
  assert.equal(ok.result.status, 200);
  assert.ok(await alive(s.id));
  const login = await inRequest({ cookies: { [LOGOUT_MARKER_COOKIE]: '1' } }, () => setSessionCookie({ token: s.token, maxAgeSec: 60 }));
  assert.ok(expired(login.sets, LOGOUT_MARKER_COOKIE), 'вход стирает метку');
  assert.ok(login.sets.some((c) => c.name === SESSION_COOKIE_PLAIN && c.value === s.token));
});
