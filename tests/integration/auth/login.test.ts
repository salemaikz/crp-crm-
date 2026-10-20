import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { attemptLogin, changeOwnPassword, logoutEverywhere } from '../../../src/server/platform/auth/login';
import { resolveSession, createSession } from '../../../src/server/platform/auth/session';
import { resetLoginThrottle } from '../../../src/server/platform/auth/throttle';
import { resetRateLimit } from '../../../src/server/platform/ratelimit';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';
import { createUser, T0 } from './helpers';
import * as pw from '../../../src/server/platform/auth/password';

const policy = DEFAULT_SECURITY_POLICY;
let db: TestDb;
before(async () => { db = await createTestDb(); });
after(async () => { await db.close(); });
beforeEach(() => resetLoginThrottle());

const login = (phone: string, password: string, extra: { next?: string; ip?: string } = {}, now = T0) =>
  db.tx((sql) => attemptLogin(sql, { phone, password, next: extra.next, ip: extra.ip ?? '203.0.113.5' }, policy, now));

test('успех: сессия, last_login_at, аудит без ПДн; номер можно вводить с 8', async () => {
  const u = await createUser(db.sql, { phone: '77015550101', password: 'Надёжный-пароль-77', name: 'Иван Секретов' });
  const r = await login('8 (701) 555-01-01', 'Надёжный-пароль-77', { next: '/leads?x=1' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.next, '/leads?x=1');
  assert.equal(r.userId, u.id);
  assert.ok(await resolveSession(db.sql, r.session.token, policy, T0 + 1));
  const audit = await db.sql<{ action: string; meta: unknown; entityId: string }>`SELECT action, meta, entity_id FROM audit_log WHERE action = 'session.login'`;
  assert.equal(audit.length, 1);
  const dump = JSON.stringify(audit);
  for (const secret of ['77015550101', '555', 'Иван', 'Секретов', r.session.token]) assert.ok(!dump.includes(secret), secret);
});

test('чужой next заменяется на «/»', async () => {
  await createUser(db.sql, { phone: '77015550102', password: 'Надёжный-пароль-77' });
  const r = await login('77015550102', 'Надёжный-пароль-77', { next: 'https://evil.test' });
  assert.equal(r.ok && r.next, '/');
});

test('нет номера и неверный пароль дают один ответ; bcrypt считается в обоих случаях', async () => {
  await createUser(db.sql, { phone: '77015550103', password: 'Надёжный-пароль-77' });
  const times: number[] = [];
  const results = [];
  for (const [phone, pass] of [['77015550103', 'неверный-пароль-1'], ['77015559999', 'неверный-пароль-1']] as const) {
    const t = performance.now();
    results.push(await login(phone, pass, { ip: `198.51.100.${times.length + 1}` }));
    times.push(performance.now() - t);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], { ok: false, error: 'invalid', retryAfterMs: null });
  assert.ok((times[1] as number) > 20, `bcrypt не вызван для несуществующего номера: ${times[1]} мс`);
});

test('отключённый, без пароля и неверный — invalid; верный пароль отключённого не пускает', async () => {
  await createUser(db.sql, { phone: '77015550104', status: 'disabled', password: 'Надёжный-пароль-77' });
  await createUser(db.sql, { phone: '77015550105', password: null });
  assert.deepEqual(await login('77015550104', 'Надёжный-пароль-77'), { ok: false, error: 'invalid', retryAfterMs: null });
  assert.deepEqual(await login('77015550105', 'Надёжный-пароль-77', { ip: '198.51.100.9' }), { ok: false, error: 'invalid', retryAfterMs: null });
});

test('validation: пусто, длинный пароль, не номер — без bcrypt и счётчиков', async () => {
  assert.deepEqual(await login('', 'x'), { ok: false, error: 'validation' });
  assert.deepEqual(await login('77015550101', ''), { ok: false, error: 'validation' });
  assert.deepEqual(await login('77015550101', 'a'.repeat(257)), { ok: false, error: 'validation' });
  assert.deepEqual(await login('abc', 'пароль-1234'), { ok: false, error: 'validation' });
});

test('перебор: после perPhone неудач — задержка, верный пароль в задержку отклонён', async () => {
  await createUser(db.sql, { phone: '77015550106', password: 'Надёжный-пароль-77' });
  for (let i = 0; i < 4; i++) {
    const r = await login('77015550106', `неверный-${i}-пароль`, { ip: `192.0.2.${i}` });
    assert.deepEqual(r, { ok: false, error: 'invalid', retryAfterMs: null });
  }
  const fifth = await login('77015550106', 'неверный-5-пароль', { ip: '192.0.2.50' });
  assert.deepEqual(fifth, { ok: false, error: 'invalid', retryAfterMs: 1000 });
  const blocked = await login('77015550106', 'Надёжный-пароль-77', { ip: '192.0.2.51' }, T0 + 500);
  assert.equal(!blocked.ok && blocked.error, 'rate_limited');
  const ok = await login('77015550106', 'Надёжный-пароль-77', { ip: '192.0.2.51' }, T0 + 1001);
  assert.equal(ok.ok, true);
});

test('старый хеш меньшей стоимости перехешируется при успешном входе', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const u = await createUser(db.sql, { phone: '77015550107' });
  await db.sql`UPDATE users SET password_hash = ${bcrypt.hashSync('Надёжный-пароль-77', 4)} WHERE id = ${u.id}`;
  assert.equal((await login('77015550107', 'Надёжный-пароль-77')).ok, true);
  const [row] = await db.sql<{ passwordHash: string }>`SELECT password_hash FROM users WHERE id = ${u.id}`;
  assert.equal(pw.needsRehash(row?.passwordHash ?? ''), false);
});

test('«выйти везде»: все сессии удалены, аудит с числом', async () => {
  const u = await createUser(db.sql);
  await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  await createSession(db.sql, { userId: u.id, policy, nowMs: T0 + 1 });
  assert.deepEqual(await db.tx((sql) => logoutEverywhere(sql, u.id, T0 + 2)), { revoked: 2 });
  const [a] = await db.sql<{ meta: { revoked: number } }>`SELECT meta FROM audit_log WHERE action = 'session.logout_all' AND entity_id = ${u.id}`;
  assert.equal(a?.meta.revoked, 2);
});

test('смена пароля: неверный текущий, политика, успех удаляет прежние сессии и выдаёт новую', async () => {
  const u = await createUser(db.sql, { phone: '77015550108', password: 'Старый-пароль-55' });
  const old = await createSession(db.sql, { userId: u.id, policy, nowMs: T0 });
  const change = (cur: string, next: string, now = T0 + 10) => db.tx((sql) => changeOwnPassword(sql, { userId: u.id, current: cur, next }, policy, now));
  assert.deepEqual(await change('не-тот-пароль', 'Новый-пароль-66'), { ok: false, error: 'wrong_current' });
  assert.deepEqual(await change('Старый-пароль-55', 'Старый-пароль-55'), { ok: false, error: 'same_as_current' });
  assert.deepEqual(await change('Старый-пароль-55', 'Кор-1'), { ok: false, error: 'too_short' });
  assert.deepEqual(await change('Старый-пароль-55', '11111111'), { ok: false, error: 'too_common' });
  const r = await change('Старый-пароль-55', 'Новый-пароль-66');
  assert.equal(r.ok, true);
  assert.equal(await resolveSession(db.sql, old.token, policy, T0 + 20), null);
  if (r.ok) assert.ok(await resolveSession(db.sql, r.session.token, policy, T0 + 20));
  assert.equal((await login('77015550108', 'Новый-пароль-66')).ok, true);
  const [a] = await db.sql<{ meta: unknown }>`SELECT meta FROM audit_log WHERE action = 'user.password_change' AND entity_id = ${u.id}`;
  assert.ok(!JSON.stringify(a).includes('Новый'));
});

test('смена пароля: лимит 5 попыток за 15 минут', async () => {
  const u = await createUser(db.sql, { password: 'Старый-пароль-55' });
  resetRateLimit(`pwchange:${u.id}`);
  const change = (now: number) => db.tx((sql) => changeOwnPassword(sql, { userId: u.id, current: 'не-тот-пароль', next: 'Новый-пароль-66' }, policy, now));
  for (let i = 0; i < 5; i++) assert.deepEqual(await change(T0 + i), { ok: false, error: 'wrong_current' });
  const r = await change(T0 + 10);
  assert.equal(!r.ok && r.error, 'rate_limited');
});
