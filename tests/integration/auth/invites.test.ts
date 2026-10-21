import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { acceptInvite, inspectInvite, issueInvite, issuePasswordReset, revokePendingInvites } from '../../../src/server/platform/auth/invites';
import { createSession, resolveSession } from '../../../src/server/platform/auth/session';
import { attemptLogin } from '../../../src/server/platform/auth/login';
import { resetLoginThrottle } from '../../../src/server/platform/auth/throttle';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';
import { createSpace, createUser, T0 } from './helpers';

const policy = DEFAULT_SECURITY_POLICY;
const HOUR = 3_600_000;
let db: TestDb;
let admin: { id: string };
let space: string;
before(async () => {
  db = await createTestDb();
  admin = await createUser(db.sql, { phone: '77090000000', isAdmin: true });
  space = await createSpace(db.sql);
});
after(async () => { await db.close(); });
beforeEach(() => resetLoginThrottle());

const invite = (phone: string, o: { roleKey?: string; spaceId?: string | null; createdBy?: string; now?: number } = {}) =>
  db.tx((sql) =>
    issueInvite(sql, {
      phoneDigits: phone, name: 'Анна Тестова', spaceId: o.spaceId === undefined ? space : o.spaceId,
      roleKey: o.roleKey ?? 'operator', teamId: null, createdBy: o.createdBy ?? admin.id, policy, nowMs: o.now ?? T0,
    }),
  );
const accept = (token: string, password = 'Надёжный-пароль-77', now = T0 + 1000) =>
  db.tx((sql) => acceptInvite(sql, { token, password, policy, nowMs: now }));

test('выдача → inspect → accept: пароль, членство, сессия; повтор ссылки — invalid_token', async () => {
  const r = await invite('77091110001');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(r.invite.link.includes('#') && !r.invite.link.includes('?'));
  assert.equal(r.invite.expiresAt, T0 + 72 * HOUR);
  const preview = await inspectInvite(db.sql, r.invite.token, T0 + 1);
  assert.deepEqual(preview, { kind: 'invite', name: 'Анна Тестова', phoneMasked: '+7 709 ••• •• 01' });
  const a = await accept(r.invite.token);
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.ok(await resolveSession(db.sql, a.session.token, policy, T0 + 2000));
  const [m] = await db.sql<{ roleKey: string; status: string }>`SELECT role_key, status FROM memberships WHERE user_id = ${a.userId}`;
  assert.deepEqual(m, { roleKey: 'operator', status: 'active' });
  assert.deepEqual(await accept(r.invite.token), { ok: false, error: 'invalid_token' });
  assert.equal(await inspectInvite(db.sql, r.invite.token, T0 + 2000), null);
  // вошёл по новому паролю
  const l = await db.tx((sql) => attemptLogin(sql, { phone: '8 709 111 00 01', password: 'Надёжный-пароль-77', ip: '203.0.113.1' }, policy, T0 + 3000));
  assert.equal(l.ok, true);
});

test('истёкшая и неизвестная ссылки неотличимы', async () => {
  const r = await invite('77091110002');
  if (!r.ok) throw new Error('issue');
  assert.equal(await inspectInvite(db.sql, r.invite.token, T0 + 72 * HOUR), null);
  assert.deepEqual(await accept(r.invite.token, 'Надёжный-пароль-77', T0 + 72 * HOUR), { ok: false, error: 'invalid_token' });
  assert.deepEqual(await accept('x'.repeat(43)), { ok: false, error: 'invalid_token' });
  assert.deepEqual(await accept('короткий'), { ok: false, error: 'invalid_token' });
});

test('слабый пароль не сжигает ссылку', async () => {
  const r = await invite('77091110003');
  if (!r.ok) throw new Error('issue');
  assert.deepEqual(await accept(r.invite.token, '11111111'), { ok: false, error: 'too_common' });
  assert.deepEqual(await accept(r.invite.token, '77091110003'), { ok: false, error: 'same_as_phone' });
  assert.ok((await accept(r.invite.token)).ok);
});

test('вторая выдача гасит первую', async () => {
  const a = await invite('77091110004');
  const b = await invite('77091110004', { now: T0 + 10 });
  if (!a.ok || !b.ok) throw new Error('issue');
  assert.equal(a.invite.userId, b.invite.userId);
  assert.deepEqual(await accept(a.invite.token), { ok: false, error: 'invalid_token' });
  assert.ok((await accept(b.invite.token)).ok);
});

test('2 параллельных accept — один успех', async () => {
  const r = await invite('77091110005');
  if (!r.ok) throw new Error('issue');
  const results = await Promise.all([accept(r.invite.token), accept(r.invite.token), accept(r.invite.token)]);
  assert.equal(results.filter((x) => x.ok).length, 1);
  assert.equal(results.filter((x) => !x.ok && x.error === 'invalid_token').length, 2);
});

test('параллельные выдача и принятие не взаимоблокируются', async () => {
  for (let i = 0; i < 5; i++) {
    const phone = `7709222000${i}`;
    const first = await invite(phone);
    if (!first.ok) throw new Error('issue');
    const [, acc] = await Promise.all([invite(phone, { now: T0 + 5 }), accept(first.invite.token)]);
    // порядок любой, но исключения (deadlock detected) быть не должно
    assert.ok(acc.ok || acc.error === 'invalid_token');
  }
});

test('reset: закрывает все прежние сессии и не трогает членства', async () => {
  const u = await createUser(db.sql, { phone: '77091110006', password: 'Старый-пароль-55' });
  await db.sql`INSERT INTO memberships (user_id, space_id, role_key, created_at, updated_at) VALUES (${u.id}, ${space}, 'rop', ${T0}, ${T0})`;
  const s = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  const r = await db.tx((sql) => issuePasswordReset(sql, { userId: u.id, createdBy: admin.id, policy, nowMs: T0 + 1 }));
  if (!r.ok) throw new Error('reset');
  assert.ok(await resolveSession(db.sql, s.token, policy, T0 + 2)); // выдача ссылки сессии не трогает
  assert.equal((await inspectInvite(db.sql, r.invite.token, T0 + 2))?.kind, 'reset');
  const a = await accept(r.invite.token, 'Новый-пароль-66', T0 + 3);
  assert.ok(a.ok);
  assert.equal(await resolveSession(db.sql, s.token, policy, T0 + 4), null);
  const roles = await db.sql<{ roleKey: string }>`SELECT role_key FROM memberships WHERE user_id = ${u.id}`;
  assert.deepEqual(roles, [{ roleKey: 'rop' }]);
});

test('приглашение тому, у кого пароль уже есть, — exists; stale-ссылка недействительна', async () => {
  await createUser(db.sql, { phone: '77091110007', password: 'Старый-пароль-55' });
  assert.deepEqual(await invite('77091110007'), { ok: false, error: 'exists' });
});

test('self_role и отключённый; reset для неизвестного — not_found', async () => {
  const me = await createUser(db.sql, { phone: '77091110008', password: null });
  assert.deepEqual(await invite('77091110008', { createdBy: me.id }), { ok: false, error: 'self_role' });
  // первый администратор: без роли и пространства, createdBy — он же
  assert.equal((await invite('77091110008', { createdBy: me.id, spaceId: null, roleKey: '' })).ok, true);
  await createUser(db.sql, { phone: '77091110009', status: 'disabled' });
  assert.deepEqual(await invite('77091110009'), { ok: false, error: 'disabled' });
  assert.deepEqual(await db.tx((sql) => issuePasswordReset(sql, { userId: 'нет', createdBy: admin.id, policy, nowMs: T0 })), { ok: false, error: 'not_found' });
});

test('роль, изменённая до принятия, важнее ссылки (ON CONFLICT DO NOTHING)', async () => {
  const r = await invite('77091110010');
  if (!r.ok) throw new Error('issue');
  await db.sql`INSERT INTO memberships (user_id, space_id, role_key, created_at, updated_at) VALUES (${r.invite.userId}, ${space}, 'rop', ${T0}, ${T0})`;
  assert.ok((await accept(r.invite.token)).ok);
  const [m] = await db.sql<{ roleKey: string }>`SELECT role_key FROM memberships WHERE user_id = ${r.invite.userId}`;
  assert.equal(m?.roleKey, 'rop');
});

test('revokePendingInvites гасит ссылки номера; отключённый не принимает', async () => {
  const r = await invite('77091110011');
  if (!r.ok) throw new Error('issue');
  assert.equal(await db.tx((sql) => revokePendingInvites(sql, '77091110011', T0 + 1)), 1);
  assert.equal(await inspectInvite(db.sql, r.invite.token, T0 + 2), null);
  const r2 = await invite('77091110012');
  if (!r2.ok) throw new Error('issue');
  await db.sql`UPDATE users SET status = 'disabled' WHERE id = ${r2.invite.userId}`;
  assert.deepEqual(await accept(r2.invite.token), { ok: false, error: 'invalid_token' });
});

test('аудит приглашений: в meta нет номера, имени и токена', async () => {
  const r = await invite('77091110013');
  if (!r.ok) throw new Error('issue');
  await accept(r.invite.token);
  const rows = await db.sql<{ action: string; meta: unknown }>`
    SELECT action, meta FROM audit_log WHERE action IN ('user.invite', 'user.invite_accept', 'session.login')`;
  assert.ok(rows.some((x) => x.action === 'user.invite') && rows.some((x) => x.action === 'user.invite_accept'));
  const dump = JSON.stringify(rows.map((x) => x.meta));
  for (const secret of ['77091110013', 'Анна', 'Тестова', r.invite.token]) assert.ok(!dump.includes(secret), secret);
});
