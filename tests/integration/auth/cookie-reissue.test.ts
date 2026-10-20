// Скользящий срок сессии (D-091, D-154): продление срока в БД идёт только вместе с перевыпуском
// cookie. route() и action() перевыпускают cookie тем же токеном; страница (серверный компонент,
// cookie менять нельзя) срок не продлевает — это делает следующий route handler или server action.
// Сессия читается настоящим getSession(): cookie → sessions → users, next/headers — подмена с записью.
import { register } from 'node:module';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestDb } from '../../../src/server/platform/db/testing';

register('./shim/hooks.mjs', import.meta.url);

const { inRequest } = await import('./shim/nextHeaders');
const { action, page, route } = await import('../../../src/server/access/wrappers');
const { overrideAccessForTests } = await import('../../../src/server/access/testing');
const { getSession, createSession, SESSION_TOUCH_INTERVAL_MS } = await import('../../../src/server/platform/auth/session');
const { SESSION_COOKIE_PLAIN } = await import('../../../src/server/platform/auth/cookie');
const { DEFAULT_SECURITY_POLICY } = await import('../../../src/server/platform/auth/types');
const { U } = await import('../../isolation/harness/seed');
const { closeWorld, openWorld } = await import('../access/world');

const ORIGIN = 'http://crm.test';
const policy = DEFAULT_SECURITY_POLICY;
const DAY_SEC = 86_400;
let db: TestDb;

before(async () => {
  db = await openWorld();
  // Сессия — настоящая (cookie → БД); настройки, лицензия и часы Viewer — из прогона
  overrideAccessForTests({ session: getSession });
  await db.sql`UPDATE users SET password_hash = 'синтетический-хеш' WHERE id IN (${U.opA}, ${U.rop})`;
});
after(() => closeWorld(db));

/** Сессия, последний раз продлённая `agoMs` назад. */
async function staleSession(userId: string, agoMs: number): Promise<{ token: string; id: string }> {
  const s = await createSession(db.sql, { userId, policy, nowMs: Date.now() - agoMs });
  return { token: s.token, id: s.sessionId };
}

async function lastSeen(id: string): Promise<number> {
  const [r] = await db.sql<{ lastSeenAt: number }>`SELECT last_seen_at FROM sessions WHERE id = ${id}`;
  return Number(r?.lastSeenAt);
}

const post = () => new Request(`${ORIGIN}/api/x`, { method: 'POST', headers: { origin: ORIGIN } });
const ctx = { params: Promise.resolve({}) };
const STALE = SESSION_TOUCH_INTERVAL_MS + 60_000;

function assertReissued(sets: { name: string; value: string; maxAge?: number }[], token: string): void {
  const mine = sets.filter((c) => c.name === SESSION_COOKIE_PLAIN);
  assert.equal(mine.length, 1, 'cookie переставлена один раз');
  assert.equal(mine[0]?.value, token, 'тем же токеном');
  const maxAge = mine[0]?.maxAge ?? 0;
  assert.ok(Math.abs(maxAge - policy.sessionDays * DAY_SEC) <= 5, `Max-Age = sessionDays от сейчас: ${maxAge}`);
}

test('route(): продлённая сессия перевыпускает cookie; повтор в пределах часа — без Set-Cookie', async () => {
  const s = await staleSession(U.opA, STALE);
  const before = await lastSeen(s.id);
  const h = route({ perm: 'authenticated' }, async ({ viewer }) => ({ who: viewer.userId }));
  const first = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => h(post(), ctx));
  assert.equal(first.result.status, 200);
  assert.deepEqual(await first.result.json(), { who: U.opA });
  assertReissued(first.sets, s.token);
  assert.ok((await lastSeen(s.id)) > before + SESSION_TOUCH_INTERVAL_MS, 'срок в БД продлён');

  const again = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => h(post(), ctx));
  assert.equal(again.result.status, 200);
  assert.deepEqual(again.sets, [], 'касание не чаще часа — cookie не трогается');
});

test('action(): продлённая сессия перевыпускает cookie', async () => {
  const s = await staleSession(U.rop, STALE);
  const act = action({ perm: 'authenticated' }, async ({ viewer }) => viewer.userId);
  const r = await inRequest({ headers: { host: 'crm.test', origin: ORIGIN }, cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => act());
  assert.deepEqual(r.result, { ok: true, data: U.rop });
  assertReissued(r.sets, s.token);
});

test('страница cookie менять не может — срок в БД не продлевается; следующий route() продлевает и перевыпускает', async () => {
  const s = await staleSession(U.opA, STALE);
  const before = await lastSeen(s.id);
  const p = page({ perm: 'authenticated' }, async ({ viewer }) => `страница ${viewer.userId}`);
  const viewed = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token }, readOnly: true }, () => p({}));
  assert.equal(viewed.result, `страница ${U.opA}`, 'страница открывается');
  assert.deepEqual(viewed.sets, []);
  assert.equal(await lastSeen(s.id), before, 'касание не «съедено» страницей');

  const h = route({ perm: 'authenticated' }, async () => 'ok');
  const r = await inRequest({ cookies: { [SESSION_COOKIE_PLAIN]: s.token } }, () => h(post(), ctx));
  assert.equal(r.result.status, 200);
  assertReissued(r.sets, s.token);
});

test('без cookie — 401 и никаких Set-Cookie', async () => {
  const h = route({ perm: 'authenticated' }, async () => 'ok');
  const r = await inRequest({}, () => h(post(), ctx));
  assert.equal(r.result.status, 401);
  assert.deepEqual(r.sets, []);
});
