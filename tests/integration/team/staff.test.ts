// Сотрудники (R2a): сервис и маршруты на Postgres 16. Синтетика прогона изоляции, номера 7709…
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { hashPassword } from '../../../src/server/platform/auth/password';
import { acceptInvite, inspectInvite } from '../../../src/server/platform/auth/invites';
import { attemptLogin } from '../../../src/server/platform/auth/login';
import { createSession, resolveSession } from '../../../src/server/platform/auth/session';
import { resetLoginThrottle } from '../../../src/server/platform/auth/throttle';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';
import { buildViewer } from '../../../src/server/access/viewer';
import { overrideAccessForTests, resetAccessForTests } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import { applySeedConfig } from '../../isolation/harness/config';
import { seedIsolation, SEED_NOW, U } from '../../isolation/harness/seed';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import * as team from '../../../src/server/domain/team';
import { GET as listGet, POST as invitePost } from '../../../src/app/api/team/staff/route';
import { PATCH as patchStaff } from '../../../src/app/api/team/staff/[id]/route';
import { POST as resendPost, DELETE as revokeDelete } from '../../../src/app/api/team/staff/[id]/invite/route';
import { POST as resetPost } from '../../../src/app/api/team/staff/[id]/password-reset/route';
import { POST as disablePost } from '../../../src/app/api/team/staff/[id]/disable/route';

const policy = DEFAULT_SECURITY_POLICY;
const PASSWORD = 'Надёжный-пароль-77';
const ORIGIN = 'http://localhost:3000';
let db: TestDb;
let admin: Viewer;

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig(); // передача дел при отключении читает настройки (роли, резервный получатель)
  const hash = await hashPassword(PASSWORD);
  // у синтетики пароля нет: «активен» = есть пароль
  await db.sql`UPDATE users SET password_hash = ${hash} WHERE status = 'active'`;
});
after(async () => {
  resetAccessForTests();
  await db.close();
});
beforeEach(async () => {
  resetLoginThrottle();
  enterSeedWorld();
  actAs(U.admin);
  admin = await viewerOf(U.admin);
});

const ctx = (id?: string) => ({ params: Promise.resolve(id ? { id } : {}) });
const req = (method: string, body?: unknown, origin: string | null = ORIGIN): Request =>
  new Request(`${ORIGIN}/api/team/staff`, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const tokenOf = (link: string) => link.split('#')[1]!;
// Свои «часы»: приглашения одного сотрудника в тестах не должны совпадать по created_at
let tick = SEED_NOW;
const clock = { now: () => (tick += 1000) };
const invite = (phone: string, o: { roleKey?: string | null; name?: string; isAdmin?: boolean } = {}) =>
  team.inviteStaff(admin, { phone, name: o.name ?? 'Синтетик Новый', roleKey: o.roleKey === undefined ? 'operator' : o.roleKey, ...(o.isAdmin ? { isAdmin: true } : {}) }, clock);
const row = async (id: string) => (await team.listStaff(admin)).staff.find((s) => s.id === id);

test('список: статусы, маска номера, роли; полного номера в ответе нет', async () => {
  const list = await team.listStaff(admin);
  const byId = new Map(list.staff.map((s) => [s.id, s]));
  assert.equal(byId.get(U.opA)?.status, 'active');
  assert.equal(byId.get(U.opA)?.roleKey, 'operator');
  assert.equal(byId.get(U.disabled)?.status, 'disabled');
  assert.equal(byId.get(U.admin)?.isAdmin, true);
  assert.equal(byId.get(U.admin)?.isSelf, true);
  assert.equal(byId.get(U.admin)?.roleKey, null); // администратор без роли
  assert.match(byId.get(U.opA)!.phoneMasked, /^\+7 709 ••• •• \d\d$/);
  const json = JSON.stringify(list);
  assert.ok(!/7709900\d{4}/.test(json), 'полный номер в ответе');
  assert.ok(!json.includes('password'), 'хеш пароля в ответе');
  assert.ok(list.roles.some((r) => r.key === 'rop'));
  assert.ok(list.roles.every((r) => r.label.length > 0));
});

test('приглашение: ссылка с токеном во фрагменте, статус «приглашён», принятие делает активным', async () => {
  const l = await invite('8 709 900 77 01', { name: 'Анна Синтетик' });
  assert.match(l.link, /^http:\/\/localhost:3000\/invite#[A-Za-z0-9_-]{43}$/);
  assert.equal(l.ttlHours, 72);
  const r = await row(l.userId);
  assert.equal(r?.status, 'invited');
  assert.equal(r?.roleKey, 'operator');
  assert.equal(r?.inviteState, 'live');
  assert.equal(r?.phoneMasked, '+7 709 ••• •• 01');
  // токен в БД только хешем
  const leak = await db.sql`SELECT 1 FROM invites WHERE token_hash = ${tokenOf(l.link)}`;
  assert.equal(leak.length, 0);

  const a = await db.tx((sql) => acceptInvite(sql, { token: tokenOf(l.link), password: PASSWORD, policy, nowMs: Date.now() }));
  assert.ok(a.ok);
  const after = await row(l.userId);
  assert.equal(after?.status, 'active');
  assert.equal(after?.roleKey, 'operator');
});

test('приглашение: уже активный, отключённый, неизвестная роль, роль самому себе', async () => {
  await assert.rejects(invite('77099000000'), { code: 'conflict', detail: 'exists' });
  await assert.rejects(invite('77099000009'), { code: 'conflict', detail: 'disabled' });
  await assert.rejects(invite('77099009902', { roleKey: 'no_such_role' }), { code: 'bad_request', detail: 'unknown_role' });
  await assert.rejects(invite('abc'), { code: 'bad_request', detail: 'phone' });
  // приглашение администратора без роли возможно, но роль самому себе — нет (issueInvite отдаёт self_role)
  const noRole = await invite('77099009903', { roleKey: null, isAdmin: true });
  const r = await row(noRole.userId);
  assert.deepEqual([r?.status, r?.isAdmin, r?.roleKey], ['invited', true, null]);
});

test('повтор приглашения гасит прежнюю ссылку; отзыв гасит все; состояние «не действует»', async () => {
  const first = await invite('77099009904');
  const second = await team.resendInvite(admin, first.userId, {}, clock);
  assert.notEqual(tokenOf(first.link), tokenOf(second.link));
  assert.equal(await inspectInvite(db.sql, tokenOf(first.link), Date.now()), null);
  assert.ok(await inspectInvite(db.sql, tokenOf(second.link), Date.now()));
  assert.deepEqual(await team.revokeInvite(admin, first.userId), { revoked: 1 });
  assert.equal(await inspectInvite(db.sql, tokenOf(second.link), Date.now()), null);
  const r = await row(first.userId);
  assert.deepEqual([r?.status, r?.inviteState, r?.roleKey], ['invited', 'inactive', 'operator']);
  // после отзыва можно выдать новую, роль при этом можно сменить
  const third = await team.resendInvite(admin, first.userId, { roleKey: 'consultant' }, clock);
  assert.equal((await row(first.userId))?.roleKey, 'consultant');
  assert.ok(await inspectInvite(db.sql, tokenOf(third.link), Date.now()));
  // активному повтор и отзыв не нужны
  await assert.rejects(team.resendInvite(admin, U.opA), { code: 'conflict', detail: 'already_active' });
  await assert.rejects(team.revokeInvite(admin, U.opA), { code: 'conflict', detail: 'already_active' });
  await assert.rejects(team.resendInvite(admin, 'no-such-user'), { code: 'not_found' });
});

test('сброс пароля: ссылка kind reset, принятие закрывает сессии и меняет пароль; приглашённому и себе — нельзя', async () => {
  const s = await db.tx((sql) => createSession(sql, { userId: U.opB, policy, nowMs: Date.now() }));
  const l = await team.resetPassword(admin, U.opB);
  assert.equal((await inspectInvite(db.sql, tokenOf(l.link), Date.now()))?.kind, 'reset');
  // пока ссылку не открыли, прежняя сессия жива
  assert.ok(await resolveSession(db.sql, s.token, policy, Date.now()));
  const a = await db.tx((sql) => acceptInvite(sql, { token: tokenOf(l.link), password: 'Новый-пароль-4242', policy, nowMs: Date.now() }));
  assert.ok(a.ok);
  assert.equal(await resolveSession(db.sql, s.token, policy, Date.now()), null);
  const login = await db.tx((sql) => attemptLogin(sql, { phone: '77099000001', password: 'Новый-пароль-4242', ip: '203.0.113.7' }, policy, Date.now()));
  assert.equal(login.ok, true);
  await assert.rejects(team.resetPassword(admin, U.admin), { code: 'forbidden' });
  await assert.rejects(team.resetPassword(admin, U.disabled), { code: 'conflict', detail: 'disabled' });
  const inv = await invite('77099009905');
  await assert.rejects(team.resetPassword(admin, inv.userId), { code: 'conflict', detail: 'not_activated' });
  await assert.rejects(team.resetPassword(admin, 'no-such-user'), { code: 'not_found' });
});

test('смена роли действует со следующего запроса; себе — нельзя; приглашённому — только повтором', async () => {
  await team.updateStaff(admin, U.opA, { roleKey: 'consultant' });
  assert.equal((await row(U.opA))?.roleKey, 'consultant');
  assert.equal((await viewerOf(U.opA)).roleKey, 'consultant');
  const [m] = await db.sql<{ roleKey: string; status: string }>`SELECT role_key, status FROM memberships WHERE user_id = ${U.opA}`;
  assert.deepEqual(m, { roleKey: 'consultant', status: 'active' });
  await team.updateStaff(admin, U.opA, { roleKey: 'operator' });

  await assert.rejects(team.updateStaff(admin, U.admin, { roleKey: 'rop' }), { code: 'forbidden' });
  await assert.rejects(team.updateStaff(admin, U.admin, { isAdmin: false }), { code: 'forbidden' });
  await assert.rejects(team.updateStaff(admin, U.opA, { roleKey: 'no_such_role' }), { code: 'bad_request', detail: 'unknown_role' });
  await assert.rejects(team.updateStaff(admin, U.disabled, { roleKey: 'rop' }), { code: 'conflict', detail: 'disabled' });
  const inv = await invite('77099009906');
  await assert.rejects(team.updateStaff(admin, inv.userId, { roleKey: 'rop' }), { code: 'conflict', detail: 'not_activated' });

  // роль администратору без неё: членство создаётся
  const r = await team.updateStaff(admin, U.director, { isAdmin: true });
  assert.deepEqual(r.changed, ['admin']);
  assert.equal((await row(U.director))?.isAdmin, true);
  assert.deepEqual((await team.updateStaff(admin, U.director, { isAdmin: false })).changed, ['admin']);
  assert.deepEqual((await team.updateStaff(admin, U.director, { roleKey: 'director' })).changed, []); // без изменений — без аудита
});

test('отключение: вход закрыт, сессии и ссылки отозваны, повтор безопасен, дела переданы (B9a)', async () => {
  const s = await db.tx((sql) => createSession(sql, { userId: U.marketer, policy, nowMs: Date.now() }));
  const res = await team.disableStaff(admin, U.marketer);
  assert.equal(res.alreadyDisabled, false);
  assert.equal(res.sessionsRevoked, 1);
  // у маркетолога нет карточек: передавать нечего, но пространство обработано
  assert.deepEqual([res.handover.status, res.handover.movedCards, res.handover.spaces.length], ['done', 0, 1]);
  assert.equal(await resolveSession(db.sql, s.token, policy, Date.now()), null);
  const login = await db.tx((sql) => attemptLogin(sql, { phone: '77099000006', password: PASSWORD, ip: '203.0.113.8' }, policy, Date.now()));
  assert.equal(login.ok, false);
  const [m] = await db.sql<{ status: string; inDistribution: boolean }>`SELECT status, in_distribution FROM memberships WHERE user_id = ${U.marketer}`;
  assert.deepEqual(m, { status: 'disabled', inDistribution: false });
  assert.equal((await row(U.marketer))?.status, 'disabled');
  await actAs(U.marketer);
  await assert.rejects(buildViewer(), { code: 'unauthorized' });
  actAs(U.admin);
  assert.equal((await team.disableStaff(admin, U.marketer)).alreadyDisabled, true);
  await assert.rejects(team.disableStaff(admin, U.admin), { code: 'forbidden' });
  await assert.rejects(team.disableStaff(admin, 'no-such-user'), { code: 'not_found' });
});

test('отключение приглашённого гасит его ссылки; сбой передачи дел откатывает отключение целиком', async () => {
  const inv = await invite('77099009907');
  await team.disableStaff(admin, inv.userId);
  assert.equal(await inspectInvite(db.sql, tokenOf(inv.link), Date.now()), null);

  const calls: string[] = [];
  const failing: team.StaffHandover = {
    run: async (_sql, input) => {
      calls.push(`${input.mode}:${input.userId}:${input.actorId}`);
      throw new Error('handover failed');
    },
  };
  await assert.rejects(team.disableStaff(admin, U.duty, { mode: 'wizard' }, { handover: failing }), /handover failed/);
  assert.deepEqual(calls, [`wizard:${U.duty}:${U.admin}`]);
  assert.equal((await row(U.duty))?.status, 'active');
  const [m] = await db.sql<{ status: string }>`SELECT status FROM memberships WHERE user_id = ${U.duty}`;
  assert.equal(m?.status, 'active');
});

test('аудит: действия записаны, в meta нет номеров, имён и токенов', async () => {
  const l = await invite('77099009908', { name: 'Секретное Имя' });
  await team.resendInvite(admin, l.userId, {}, clock);
  await team.revokeInvite(admin, l.userId);
  await team.updateStaff(admin, U.rop, { roleKey: 'director' });
  await team.updateStaff(admin, U.rop, { roleKey: 'rop' });
  await team.resetPassword(admin, U.rop);
  await team.disableStaff(admin, U.mktHead);
  const rows = await db.sql<{ action: string; actorId: string; meta: unknown }>`
    SELECT action, actor_id, meta FROM audit_log WHERE action IN ('user.invite','user.invite_revoke','user.role_change','user.password_reset_issue','user.disable')`;
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ['user.invite', 'user.invite_revoke', 'user.role_change', 'user.password_reset_issue', 'user.disable']) assert.ok(actions.has(a), a);
  assert.ok(rows.every((r) => r.actorId === U.admin));
  const dump = JSON.stringify(rows.map((r) => r.meta));
  assert.ok(!dump.includes('77099009908') && !dump.includes('Секретное') && !dump.includes(tokenOf(l.link)));
  assert.ok(!/7709900\d{4}/.test(dump));
});

test('маршруты: администратор работает, остальные получают отказ без изменений', async () => {
  const list = await listGet(req('GET'), ctx());
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('Cache-Control'), 'no-store');

  const created = await invitePost(req('POST', { name: 'Через Маршрут', phone: '+7 709 900 99 11', roleKey: 'operator' }), ctx());
  assert.equal(created.status, 200);
  const body = (await created.json()) as { userId: string; link: string };
  assert.match(body.link, /#[A-Za-z0-9_-]+$/);

  // без Origin, чужой Origin, битый JSON, лишние поля
  assert.equal((await invitePost(req('POST', {}, null), ctx())).status, 403);
  assert.equal((await invitePost(req('POST', {}, 'https://evil.example'), ctx())).status, 403);
  const broken = new Request(`${ORIGIN}/api/team/staff`, { method: 'POST', headers: { Origin: ORIGIN }, body: '{' });
  assert.equal((await invitePost(broken, ctx())).status, 400);
  assert.equal((await invitePost(req('POST', { name: 'X', phone: '+7 709 900 99 12', roleKey: 'operator', extra: 1 }), ctx())).status, 400);
  assert.equal((await patchStaff(req('PATCH', { roleKey: 'rop' }), ctx(U.admin))).status, 403); // себе нельзя
  assert.equal((await patchStaff(req('PATCH', {}), ctx(U.opA))).status, 400);

  const before = (await db.sql`SELECT count(*)::int AS n FROM users`)[0]!.n as number;
  for (const who of [U.opA, U.rop, U.director, null]) {
    actAs(who);
    const expect = who === null ? 401 : 403;
    // роль «только чтение» (директор): мутации получают 423 раньше проверки права — тоже без изменений
    const mut = who === U.director ? 423 : expect;
    assert.equal((await listGet(req('GET'), ctx())).status, expect, String(who));
    assert.equal((await invitePost(req('POST', { name: 'Чужой', phone: '+7 709 900 99 13', roleKey: 'operator' }), ctx())).status, mut);
    assert.equal((await patchStaff(req('PATCH', { isAdmin: true }), ctx(U.opB))).status, mut);
    assert.equal((await resendPost(req('POST', {}), ctx(body.userId))).status, mut);
    assert.equal((await revokeDelete(req('DELETE'), ctx(body.userId))).status, mut);
    assert.equal((await resetPost(req('POST'), ctx(U.opB))).status, expect); // мутации безопасности (D-054) «только чтением» не блокируются
    assert.equal((await disablePost(req('POST', {}), ctx(U.opB))).status, expect);
  }
  actAs(U.admin);
  assert.equal((await db.sql`SELECT count(*)::int AS n FROM users`)[0]!.n, before);
  assert.equal((await row(U.opB))?.status, 'active');
  assert.equal((await row(U.opB))?.isAdmin, false);
});

test('лицензия «только чтение»: приглашение и роль закрыты (423), сброс пароля и отключение (D-054) работают', async () => {
  overrideAccessForTests({ license: async () => 'read_only', now: () => SEED_NOW });
  const target = await db.sql<{ id: string }>`SELECT id FROM users WHERE id = ${U.opB}`;
  assert.equal(target.length, 1);
  assert.equal((await invitePost(req('POST', { name: 'Закрыто', phone: '+7 709 900 99 14', roleKey: 'operator' }), ctx())).status, 423);
  assert.equal((await patchStaff(req('PATCH', { roleKey: 'rop' }), ctx(U.opB))).status, 423);
  assert.equal((await resendPost(req('POST', {}), ctx(U.opB))).status, 423);
  assert.equal((await listGet(req('GET'), ctx())).status, 200);
  assert.equal((await resetPost(req('POST'), ctx(U.opB))).status, 200);
  const off = await disablePost(req('POST', { mode: 'urgent' }), ctx(U.opB));
  assert.equal(off.status, 200);
  const body = (await off.json()) as { handover: { status: string; movedCards: number } };
  assert.deepEqual([body.handover.status, body.handover.movedCards], ['done', 100]); // «срочное» отключение работает и при лицензии «только чтение»
  assert.equal((await row(U.opB))?.status, 'disabled');
});
