import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import {
  createSession, hashSessionToken, MAX_SESSIONS_PER_USER, resolveSession, revokeAllSessions, revokeSessionByToken,
  SESSION_TOUCH_INTERVAL_MS,
} from '../../../src/server/platform/auth/session';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';
import { createUser, DAY, T0 } from './helpers';

const policy = DEFAULT_SECURITY_POLICY;
let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.close(); });

test('создание → чтение; в БД лежит sha256, а не токен', async () => {
  const u = await createUser(db.sql);
  const s = await db.tx((sql) => createSession(sql, { userId: u.id, policy, nowMs: T0 }));
  assert.equal(s.token.length, 43);
  assert.equal(s.sessionId, hashSessionToken(s.token));
  assert.equal(s.maxAgeSec, 30 * 86400);
  const rows = await db.sql<{ id: string }>`SELECT id FROM sessions WHERE user_id = ${u.id}`;
  assert.deepEqual(rows.map((r) => r.id), [s.sessionId]);
  const r = await resolveSession(db.sql, s.token, policy, T0 + 1000);
  assert.equal(r?.userId, u.id);
  assert.equal(r?.touched, false);
  const [user] = await db.sql<{ lastLoginAt: number }>`SELECT last_login_at FROM users WHERE id = ${u.id}`;
  assert.equal(user?.lastLoginAt, T0);
  assert.equal(await resolveSession(db.sql, s.token.slice(1), policy, T0), null);
  assert.equal(await resolveSession(db.sql, null, policy, T0), null);
});

test('истечение и касание не чаще часа', async () => {
  const u = await createUser(db.sql);
  const s = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  assert.equal(await resolveSession(db.sql, s.token, policy, T0 + 30 * DAY + 1), null);
  const early = await resolveSession(db.sql, s.token, policy, T0 + SESSION_TOUCH_INTERVAL_MS - 1);
  assert.equal(early?.touched, false);
  const later = await resolveSession(db.sql, s.token, policy, T0 + SESSION_TOUCH_INTERVAL_MS);
  assert.equal(later?.touched, true);
  assert.equal(later?.expiresAt, T0 + SESSION_TOUCH_INTERVAL_MS + 30 * DAY);
  const again = await resolveSession(db.sql, s.token, policy, T0 + SESSION_TOUCH_INTERVAL_MS + 1000);
  assert.equal(again?.touched, false);
});

test('уменьшение sessionDays гасит старые сессии сразу', async () => {
  const u = await createUser(db.sql);
  const a = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  const b = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + 1 });
  const short = { ...policy, sessionDays: 7 };
  assert.ok(await resolveSession(db.sql, a.token, short, T0 + 6 * DAY)); // касание продлевает от последнего визита
  assert.equal(await resolveSession(db.sql, b.token, short, T0 + 8 * DAY), null); // не заходила 8 дней при сроке 7
});

test('отключённый и без пароля — гость', async () => {
  const off = await createUser(db.sql, { status: 'disabled' });
  const nopw = await createUser(db.sql, { password: null });
  for (const u of [off, nopw]) {
    const s = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
    assert.equal(await resolveSession(db.sql, s.token, policy, T0 + 1), null);
  }
});

test('11-я сессия вытесняет самую давно не использованную', async () => {
  const u = await createUser(db.sql);
  const issued = [];
  for (let i = 0; i < MAX_SESSIONS_PER_USER + 1; i++) {
    issued.push(await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + i * 1000 }));
  }
  const rows = await db.sql<{ id: string }>`SELECT id FROM sessions WHERE user_id = ${u.id}`;
  assert.equal(rows.length, MAX_SESSIONS_PER_USER);
  assert.equal(await resolveSession(db.sql, (issued[0] as { token: string }).token, policy, T0 + 20_000), null);
  assert.ok(await resolveSession(db.sql, (issued[10] as { token: string }).token, policy, T0 + 20_000));
});

test('истёкшие сессии сотрудника чистятся при входе', async () => {
  const u = await createUser(db.sql);
  await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + 31 * DAY });
  const [c] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${u.id}`;
  assert.equal(c?.n, 1);
});

test('revokeAllSessions с exceptSessionId и revokeSessionByToken', async () => {
  const u = await createUser(db.sql);
  const a = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  const b = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + 1 });
  const c = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + 2 });
  await revokeSessionByToken(db.sql, a.token);
  await revokeSessionByToken(db.sql, 'мусор');
  assert.equal(await resolveSession(db.sql, a.token, policy, T0 + 5), null);
  assert.equal(await revokeAllSessions(db.sql, u.id, { exceptSessionId: c.sessionId }), 1);
  assert.equal(await resolveSession(db.sql, b.token, policy, T0 + 5), null);
  assert.ok(await resolveSession(db.sql, c.token, policy, T0 + 5));
  assert.equal(await revokeAllSessions(db.sql, u.id), 1);
});
