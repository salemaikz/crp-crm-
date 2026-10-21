// Web-push (P8b, D-328): переключатель и отметка решения, подписка устройства с привязкой к сессии, наполнение
// очереди только своими непрочитанными уведомлениями из списка, текст без ПДн (расшифровываем ключом устройства),
// общий телефон (смена владельца, выход), ответы push-сервиса. Только синтетика: ключи устройства — пример RFC 8291.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, randomBytes } from 'node:crypto';
import { systemActor } from '../../../src/server/access/systemActor';
import { BadRequestError } from '../../../src/server/access/errors';
import {
  disablePush,
  fillPushOutbox,
  overridePushDepsForTests,
  purgePushSubscriptions,
  pushAdminState,
  pushStatus,
  sendPushItem,
  setPushSettings,
  subscribePush,
  unsubscribePush,
  PUSH_FILL_WINDOW_MS,
  PUSH_MAX_SUBSCRIPTIONS,
} from '../../../src/server/domain/notify';
import { pushHandlers } from '../../../src/server/jobs/push';
import { runQueuePass } from '../../../src/server/platform/jobs';
import { generateVapidKeys, readVapidKeys } from '../../../src/server/platform/push';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { closeWorld, openWorld } from '../access/world';
import { viewerOf } from '../../isolation/harness/actors';
import { SEED_NOW, U } from '../../isolation/harness/seed';

const MIN = 60_000;
const d = (s: string) => Buffer.from(s, 'base64url');
// Ключи устройства из примера RFC 8291 §5: приватный нужен тесту, чтобы расшифровать тело так, как это сделает браузер
const UA_PRIVATE = d('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const EP = (n: number) => `https://fcm.googleapis.com/fcm/send/synthetic-${n}`;
const device = (n: number) => ({ endpoint: EP(n), p256dh: UA_PUBLIC, auth: UA_AUTH, deviceId: `synthetic-device-${n}` });
const sid = () => randomBytes(32).toString('hex');

type Call = { url: string; headers: Record<string, string>; body: Uint8Array };
let db: TestDb;
let calls: Call[] = [];
let reply = 201;
const vapidEnv = (() => {
  const k = generateVapidKeys();
  return { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:support@example.invalid' };
})();
let flag = true;

before(async () => {
  db = await openWorld();
  await db.sql`UPDATE users SET password_hash = 'synthetic-hash' WHERE id IN (${U.opA}, ${U.opB}, ${U.rop}, ${U.admin})`;
  overridePushDepsForTests({
    flagOn: () => flag,
    vapid: () => readVapidKeys(vapidEnv),
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
      return new Response(null, { status: reply });
    },
  });
});
after(async () => {
  overridePushDepsForTests(null);
  await closeWorld(db);
});
beforeEach(() => {
  calls = [];
  reply = 201;
  flag = true;
});

async function session(userId: string, now = SEED_NOW): Promise<string> {
  const id = sid();
  await db.sql`INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (${id}, ${userId}, ${now}::bigint, ${now + 30 * 86_400_000}::bigint, ${now}::bigint)`;
  return id;
}

let nseq = 0;
async function notify(userId: string, kind: string, params: Record<string, unknown>, at = SEED_NOW): Promise<string> {
  const id = `n-push-${++nseq}`;
  await db.sql`INSERT INTO notifications (id, user_id, kind, params, not_before, created_at)
               VALUES (${id}, ${userId}, ${kind}, ${db.json(params)}, ${at}::bigint, ${at}::bigint)`;
  return id;
}

const system = (now = SEED_NOW) => systemActor('push_outbox', now);
const fill = (now = SEED_NOW, shift: (at: number) => number = (at) => at) => fillPushOutbox(system(now), { now, nextAt: shift });
const outbox = () => db.sql<{ id: string; notificationId: string; subscriptionId: string; state: string; error: string; payload: unknown; nextAt: number }>`
  SELECT id, notification_id, subscription_id, state, error, payload, next_at FROM push_outbox ORDER BY created_at, id`;
const subs = () => db.sql<{ id: string; userId: string; endpoint: string; disabledAt: number | null; sessionId: string | null }>`
  SELECT id, user_id, endpoint, disabled_at, session_id FROM push_subscriptions ORDER BY created_at, id`;
const rowOf = async (notificationId: string) => (await outbox()).find((r) => r.notificationId === notificationId);

/** Расшифровать тело запроса ключом устройства (RFC 8291 §3.4, сторона браузера). */
function decrypt(body: Uint8Array): unknown {
  const b = Buffer.from(body);
  const salt = b.subarray(0, 16);
  const idlen = b[20]!;
  const asPublic = b.subarray(21, 21 + idlen);
  const ct = b.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(UA_PRIVATE);
  const secret = ecdh.computeSecret(asPublic);
  const h = (k: Uint8Array, m: Uint8Array) => createHmac('sha256', k).update(m).digest();
  const ikm = h(h(d(UA_AUTH), secret), Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), d(UA_PUBLIC), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const dec = createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  assert.equal(plain[plain.length - 1], 2, 'разделитель последней записи');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

const badRequest = (detail: string) => (e: unknown) => e instanceof BadRequestError && e.detail === detail;

test('пока администратор не отметил решение клиента и не включил — push недоступен, подписка не принимается', async () => {
  const opA = await viewerOf(U.opA);
  assert.deepEqual(await pushStatus(opA), { available: false, publicKey: null });
  await assert.rejects(subscribePush(opA, await session(U.opA), device(1)), badRequest('push_off'));
  const state = await pushAdminState(await viewerOf(U.admin));
  assert.equal(state.usable, false);
  assert.equal(state.reason, 'crossborder_not_approved');
  assert.equal(state.keys, 'ok');
});

test('отметка решения требует дату; включение без отметки невозможно; всё пишется в журнал', async () => {
  const admin = await viewerOf(U.admin);
  await assert.rejects(setPushSettings(admin, { enabled: true, crossborderApproved: true, decisionDate: null }), badRequest('push_decision_date'));
  const off = await setPushSettings(admin, { enabled: true, crossborderApproved: false, decisionDate: null });
  assert.equal(off.enabled, false, 'без отметки не включается');
  flag = false;
  await assert.rejects(setPushSettings(admin, { enabled: true, crossborderApproved: true, decisionDate: '2026-10-27' }), badRequest('push_flag_off'));
  flag = true;
  const on = await setPushSettings(admin, { enabled: true, crossborderApproved: true, decisionDate: '2026-10-27' });
  assert.deepEqual({ usable: on.usable, enabled: on.enabled, approved: on.crossborderApprovedAt !== null }, { usable: true, enabled: true, approved: true });
  const log = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'push.settings' ORDER BY created_at, id`;
  assert.ok(log.some((r) => r.meta.decisionDate === '2026-10-27' && r.meta.enabled === true));
  const st = await pushStatus(await viewerOf(U.opA));
  assert.equal(st.available, true);
  assert.equal(st.publicKey, vapidEnv.VAPID_PUBLIC_KEY);
});

test('подписка: только адрес push-сервиса и верные ключи устройства', async () => {
  const opA = await viewerOf(U.opA);
  const s = await session(U.opA);
  await assert.rejects(subscribePush(opA, s, { ...device(1), endpoint: 'https://example.invalid/push' }), badRequest('push_endpoint'));
  await assert.rejects(subscribePush(opA, s, { ...device(1), endpoint: 'http://127.0.0.1:5432/' }), badRequest('push_endpoint'));
  await assert.rejects(subscribePush(opA, s, { ...device(1), p256dh: UA_PUBLIC.slice(0, -4) + 'AAAA' }), badRequest('push_keys'));
  await assert.rejects(subscribePush(opA, s, { ...device(1), auth: 'AAAA' }), badRequest('push_keys'));
  assert.equal((await subs()).length, 0);
});

test('push уходит только своим, только видам из списка, текст — вид и числа; тело расшифровывается ключом устройства', async () => {
  const opA = await viewerOf(U.opA);
  await subscribePush(opA, await session(U.opA), device(1));
  const mine = await notify(U.opA, 'client_transferred', { count: 2, name: 'ТОО Синтетика Альфа 1', phone: 77090000001 });
  await notify(U.opA, 'card_merged', {}); // вида нет в списке push — только колокол
  await notify(U.opB, 'client_transferred', { count: 5 }); // чужое: у B нет подписки
  assert.equal(await fill(), 1);
  assert.equal(await fill(), 0, 'повтор наполнения не задваивает');
  const row = (await rowOf(mine))!;
  assert.deepEqual(row.payload, { kind: 'client_transferred', n: { count: 2 } }, 'строки и длинные числа не попали даже в очередь');

  assert.deepEqual(await sendPushItem(system(), row.id, SEED_NOW), { status: 'done' });
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, EP(1));
  assert.equal(c.headers['Content-Encoding'], 'aes128gcm');
  assert.match(c.headers.Authorization!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(c.headers.TTL, String(12 * 3600));
  const msg = decrypt(c.body) as { title: string; body: string; tag: string; url: string };
  assert.deepEqual(msg, { title: 'Новое уведомление', body: 'Вам передано клиентов: 2', tag: 'client_transferred', url: '/notifications' });
  assert.doesNotMatch(JSON.stringify(msg), /Синтетика|7709/);
});

test('прочитанное до отправки и старое не уходит; новая подписка не получает прошлых уведомлений', async () => {
  const opA = await viewerOf(U.opA);
  const read = await notify(U.opA, 'task_assigned', {});
  await fill();
  await db.sql`UPDATE notifications SET read_at = ${SEED_NOW}::bigint WHERE id = ${read}`;
  assert.deepEqual(await sendPushItem(system(), (await rowOf(read))!.id, SEED_NOW), { status: 'cancelled', error: 'read' });

  const old = await notify(U.opA, 'task_assigned', {}, SEED_NOW - PUSH_FILL_WINDOW_MS - MIN);
  const beforeSub = await notify(U.opA, 'task_assigned', {}, SEED_NOW - MIN);
  await subscribePush(opA, await session(U.opA), device(2)); // время подписки — SEED_NOW
  await fill(SEED_NOW + MIN);
  assert.equal((await outbox()).some((o) => o.notificationId === old), false, 'старше окна наполнения');
  const sub2 = (await subs()).find((x) => x.endpoint === EP(2))!.id;
  assert.equal((await outbox()).some((o) => o.notificationId === beforeSub && o.subscriptionId === sub2), false, 'уведомления до подписки в неё не идут');
});

test('тихие часы: next_at — ближайший рабочий момент; задержка больше 6 ч — отмена', async () => {
  const n = await notify(U.opA, 'task_assigned', {});
  const nineAm = SEED_NOW + 3 * 60 * MIN;
  await fill(SEED_NOW, () => nineAm);
  const row = (await rowOf(n))!;
  assert.equal(Number(row.nextAt), nineAm);
  assert.deepEqual(await sendPushItem(system(), row.id, nineAm + 7 * 60 * MIN), { status: 'cancelled', error: 'stale' });
});

test('общий телефон: другой сотрудник подписал то же устройство — очередь прежнего отменена, дальше push только новому', async () => {
  const opA = await viewerOf(U.opA);
  const opB = await viewerOf(U.opB);
  await subscribePush(opA, await session(U.opA), device(7));
  const forA = await notify(U.opA, 'task_assigned', {});
  await fill();
  // у сотрудника A есть и другие подписки (прежние тесты): смотрим строку именно этого устройства
  const sub7Id = (await subs()).find((s) => s.endpoint === EP(7))!.id;
  const rowOn7 = async () => (await outbox()).find((o) => o.notificationId === forA && o.subscriptionId === sub7Id)!;
  assert.equal((await rowOn7()).state, 'pending');
  await subscribePush(opB, await session(U.opB), device(7));
  const r = await rowOn7();
  assert.deepEqual({ state: r.state, error: r.error }, { state: 'cancelled', error: 'owner_changed' });
  const sub7 = (await subs()).find((s) => s.endpoint === EP(7))!;
  assert.equal(sub7.userId, U.opB);
  const laterA = await notify(U.opA, 'task_assigned', {}, SEED_NOW + MIN);
  const laterB = await notify(U.opB, 'task_assigned', {}, SEED_NOW + MIN);
  await fill(SEED_NOW + MIN);
  assert.equal((await outbox()).some((o) => o.notificationId === laterA && o.subscriptionId === sub7.id), false);
  assert.equal((await rowOf(laterB))!.subscriptionId, sub7.id);
});

test('выход: сессии нет — подписка выключается, стоящее отменяется, отправка не идёт', async () => {
  const opA = await viewerOf(U.opA);
  const s = await session(U.opA);
  await subscribePush(opA, s, device(8));
  const n = await notify(U.opA, 'task_assigned', {}, SEED_NOW + 2 * MIN);
  await fill(SEED_NOW + 2 * MIN);
  const subId = (await subs()).find((x) => x.endpoint === EP(8))!.id;
  const row = (await outbox()).find((o) => o.notificationId === n && o.subscriptionId === subId)!;
  await db.sql`DELETE FROM sessions WHERE id = ${s}`; // выход, «выйти везде», отключение — строки сессии нет
  assert.deepEqual(await sendPushItem(system(), row.id, SEED_NOW + 2 * MIN), { status: 'cancelled', error: 'session_gone' });
  await fill(SEED_NOW + 3 * MIN);
  const sub = (await subs()).find((x) => x.endpoint === EP(8))!;
  assert.notEqual(sub.disabledAt, null);
  assert.equal(calls.length, 0);
});

test('отписка: своя сессия и свой адрес; чужую подписку по адресу не снять', async () => {
  const opA = await viewerOf(U.opA);
  const opB = await viewerOf(U.opB);
  const sA = await session(U.opA);
  await subscribePush(opA, sA, device(9));
  assert.deepEqual(await unsubscribePush(opB, await session(U.opB), EP(9)), { disabled: 0 });
  assert.equal((await subs()).find((x) => x.endpoint === EP(9))!.disabledAt, null);
  assert.deepEqual(await unsubscribePush(opA, sA, null), { disabled: 1 });
  assert.notEqual((await subs()).find((x) => x.endpoint === EP(9))!.disabledAt, null);
});

test('ответы push-сервиса: 410 выключает подписку, 503 — повтор, 400 — окончательно', async () => {
  const opA = await viewerOf(U.opA);
  await subscribePush(opA, await session(U.opA), device(10));
  const subId = (await subs()).find((x) => x.endpoint === EP(10))!.id;
  const at = SEED_NOW + 5 * MIN;
  const n1 = await notify(U.opA, 'task_assigned', {}, at);
  await fill(at);
  const target = (await outbox()).find((o) => o.notificationId === n1 && o.subscriptionId === subId)!;
  reply = 503;
  assert.deepEqual(await sendPushItem(system(), target.id, at), { status: 'retry', error: 'http_503' });
  reply = 400;
  assert.deepEqual(await sendPushItem(system(), target.id, at), { status: 'failed', error: 'http_400' });
  reply = 410;
  assert.deepEqual(await sendPushItem(system(), target.id, at), { status: 'cancelled', error: 'gone' });
  assert.notEqual((await subs()).find((x) => x.id === subId)!.disabledAt, null, 'подписки у сервиса нет — выключена');
});

test('проход очереди: наполнение перед пачкой, отмена пишется состоянием cancelled', async () => {
  await db.sql`UPDATE push_outbox SET state = 'cancelled' WHERE state = 'pending'`;
  const opA = await viewerOf(U.opA);
  await subscribePush(opA, await session(U.opA), device(11));
  const at = SEED_NOW + 10 * MIN;
  const n = await notify(U.opA, 'task_assigned', {}, at);
  const spec = { name: 'push_outbox' as const, batch: 50, leaseMs: 60_000, maxAttempts: 5, handlers: pushHandlers(() => at), enabled: () => true, writes: 'business' as const, fill: (actor: ReturnType<typeof system>, now: number) => fillPushOutbox(actor, { now, nextAt: (x) => x }) };
  const log = { info: () => {}, warn: () => {} };
  const s1 = await runQueuePass(db, spec, { actor: system(at), now: () => at, signal: new AbortController().signal, log });
  assert.ok(s1.filled >= 1);
  assert.ok(s1.done >= 1);
  const sent = (await outbox()).filter((o) => o.notificationId === n);
  assert.ok(sent.every((o) => o.state === 'sent'));

  await disablePush(await viewerOf(U.admin));
  const n2 = await notify(U.opA, 'task_assigned', {}, at + MIN);
  const s2 = await runQueuePass(db, spec, { actor: system(at + MIN), now: () => at + MIN, signal: new AbortController().signal, log });
  assert.equal(s2.filled, 0, 'выключен — очередь не наполняется');
  assert.equal(await rowOf(n2), undefined);
  // строка, вставшая до выключения, при отправке отменяется
  await db.sql`INSERT INTO push_outbox (id, notification_id, subscription_id, payload, next_at, created_at)
               SELECT 'po-late', ${n2}, id, '{"kind":"task_assigned","n":{}}'::jsonb, ${at}::bigint, ${at}::bigint FROM push_subscriptions WHERE endpoint = ${EP(11)}`;
  const s3 = await runQueuePass(db, spec, { actor: system(at + MIN), now: () => at + MIN, signal: new AbortController().signal, log });
  assert.equal(s3.cancelled, 1);
  const [late] = await db.sql<{ state: string; error: string }>`SELECT state, error FROM push_outbox WHERE id = 'po-late'`;
  assert.deepEqual({ ...late }, { state: 'cancelled', error: 'push_off' });
  await setPushSettings(await viewerOf(U.admin), { enabled: true, crossborderApproved: true, decisionDate: null });
});

test('у сотрудника не больше 10 действующих подписок; выключенные без очереди чистятся через 30 дней', async () => {
  const rop = await viewerOf(U.rop);
  const s = await session(U.rop);
  for (let i = 0; i < PUSH_MAX_SUBSCRIPTIONS + 2; i++) await subscribePush(rop, s, device(100 + i));
  const mine = (await subs()).filter((x) => x.userId === U.rop);
  assert.equal(mine.filter((x) => x.disabledAt === null).length, PUSH_MAX_SUBSCRIPTIONS);
  const purged = await purgePushSubscriptions(system(), SEED_NOW + 31 * 86_400_000);
  assert.ok(purged >= 2);
});
