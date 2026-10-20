import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, testDatabaseUrl, type TestDb } from '../../../src/server/platform/db/testing';
import { createPostgresDb } from '../../../src/server/platform/db/postgres';
import type { Db } from '../../../src/server/platform/db';
import { inflightSizes } from '../../../src/server/platform/auth/throttle';
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

const login = (phone: string, password: string, extra: { next?: string; ip?: string; previousToken?: string } = {}, now = T0) =>
  attemptLogin(db, { phone, password, next: extra.next, ip: extra.ip ?? '203.0.113.5', previousToken: extra.previousToken }, policy, now);

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

test('перебор пачкой: 60 параллельных попыток на один номер — не больше perPhone проверок пароля, остальные 429', async () => {
  await createUser(db.sql, { phone: '77015550120', password: 'Надёжный-пароль-77' });
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => login('77015550120', `неверный-${i}-пароль`, { ip: '203.0.113.60' })),
  );
  const invalid = results.filter((r) => !r.ok && r.error === 'invalid');
  const limited = results.filter((r) => !r.ok && r.error === 'rate_limited');
  assert.equal(invalid.length, policy.loginAttempts.perPhone, 'проверок пароля ровно perPhone');
  assert.equal(limited.length, 60 - policy.loginAttempts.perPhone);
  assert.deepEqual(inflightSizes(), { phones: 0, ips: 0 }, 'слоты освобождены');
  // и верный пароль сразу после пачки — в задержке
  const blocked = await login('77015550120', 'Надёжный-пароль-77', { ip: '203.0.113.61' }, T0 + 10);
  assert.equal(!blocked.ok && blocked.error, 'rate_limited');
});

test('bcrypt вне транзакции: неудачные входы не открывают транзакций, пул не исчерпывается', async () => {
  const [row] = await db.sql<{ schema: string }>`SELECT current_schema() AS schema`;
  const schema = row?.schema as string;
  const prevMax = process.env.DB_POOL_MAX;
  process.env.DB_POOL_MAX = '1';
  const small = await createPostgresDb(testDatabaseUrl(), { schema });
  if (prevMax === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = prevMax;
  try {
    // Дорогой хеш (cost 13): bcryptjs считает его порциями и отдаёт цикл событий — видно, держит ли вход соединение
    const bcrypt = (await import('bcryptjs')).default;
    const u = await createUser(db.sql, { phone: '77015553300', password: null });
    await db.sql`UPDATE users SET password_hash = ${bcrypt.hashSync('Надёжный-пароль-77', 13)} WHERE id = ${u.id}`;
    let txOpened = 0;
    const counted: Db = { ...small, tx: (fn) => { txOpened++; return small.tx(fn); } };
    let firstLoginAt = Infinity;
    const logins = Array.from({ length: 3 }, (_, i) =>
      attemptLogin(counted, { phone: '77015553300', password: `неверный-${i}-пароль`, ip: `198.51.100.${100 + i}` }, policy, T0).then((r) => {
        firstLoginAt = Math.min(firstLoginAt, performance.now());
        return r;
      }),
    );
    await new Promise((r) => setTimeout(r, 30)); // входы прочитали сотрудника и считают bcrypt
    // Пул из одного соединения: посторонний запрос не ждёт окончания bcrypt
    await small.sql`SELECT 1`;
    const selectAt = performance.now();
    const results = await Promise.all(logins);
    assert.ok(results.every((r) => !r.ok && r.error === 'invalid'));
    assert.equal(txOpened, 0, 'неудачный вход транзакцию не открывает');
    assert.ok(selectAt < firstLoginAt, 'соединение не держится на время bcrypt');

    // успешный вход — одна короткая транзакция на выдачу сессии
    await createUser(db.sql, { phone: '77015553301', password: 'Надёжный-пароль-77' });
    const ok = await attemptLogin(counted, { phone: '77015553301', password: 'Надёжный-пароль-77', ip: '198.51.100.200' }, policy, T0);
    assert.equal(ok.ok, true);
    assert.equal(txOpened, 1);
  } finally {
    await small.close();
  }
});

test('повторный вход в том же браузере гасит прежнюю сессию (в том числе чужую)', async () => {
  const a = await createUser(db.sql, { phone: '77015550130', password: 'Надёжный-пароль-77' });
  await createUser(db.sql, { phone: '77015550131', password: 'Надёжный-пароль-77' });
  const first = await login('77015550130', 'Надёжный-пароль-77', { ip: '203.0.113.70' });
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = await login('77015550130', 'Надёжный-пароль-77', { ip: '203.0.113.70', previousToken: first.session.token }, T0 + 1);
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(await resolveSession(db.sql, first.session.token, policy, T0 + 2), null, 'прежняя сессия браузера удалена');
  assert.equal((await resolveSession(db.sql, second.session.token, policy, T0 + 2))?.userId, a.id);
  // другой сотрудник входит в том же браузере — сессия первого в этом браузере тоже гаснет
  const other = await login('77015550131', 'Надёжный-пароль-77', { ip: '203.0.113.70', previousToken: second.session.token }, T0 + 3);
  assert.ok(other.ok);
  assert.equal(await resolveSession(db.sql, second.session.token, policy, T0 + 4), null);
  // мусор вместо токена ничего не ломает
  assert.ok((await login('77015550130', 'Надёжный-пароль-77', { ip: '203.0.113.70', previousToken: 'не-токен' }, T0 + 5)).ok);
});

test('сотрудника отключили между проверкой пароля и выдачей сессии — входа нет', async () => {
  const u = await createUser(db.sql, { phone: '77015550140', password: 'Надёжный-пароль-77' });
  // транзакция выдачи сессии видит уже отключённого сотрудника
  const racing: Db = {
    ...db,
    tx: async (fn) => {
      await db.sql`UPDATE users SET status = 'disabled' WHERE id = ${u.id}`;
      return db.tx(fn);
    },
  };
  const r = await attemptLogin(racing, { phone: '77015550140', password: 'Надёжный-пароль-77', ip: '203.0.113.80' }, policy, T0);
  assert.deepEqual(r, { ok: false, error: 'invalid', retryAfterMs: null });
  assert.equal((await db.sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`).length, 0);
});
