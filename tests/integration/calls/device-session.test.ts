// Сверка сессии вкладки GET /api/device/session (D-292) и сообщение о потере итогов POST /api/device/outbox-expired
// (D-293 п. 2, D-308). Сверка ничего не пишет. Потеря — мутация безопасности: работает при любой лицензии и для роли
// «только чтение» (ПДн уходят с общего телефона). Свою потерю сообщает и сам автор, вошедший на телефон (D-309). Журнал
// пишется только о существующем сотруднике и только об opId, которых нет среди звонков; в meta раздельно «заявлено
// телефоном» и «подтверждено сервером»; частота ограничена.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../../src/app/api/device/session/route';
import { POST } from '../../../src/app/api/device/outbox-expired/route';
import { EXPIRED_CHECK_AFTER_MS, EXPIRED_REPORT_LIMITS, verifyExpiredLosses } from '../../../src/server/domain/calls';
import { systemActor } from '../../../src/server/access/systemActor';
import { lockExpiredClaims } from '../../../src/server/domain/calls/repo';
import type { LicenseState } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SPACE, U, cardOf, clientOf, phoneOf } from '../../isolation/harness/seed';
import { actAs } from '../../isolation/harness/actors';
import { SEED_NOW, closeCallsWorld, enterSeedWorld, openCallsWorld, uuid } from './world';

const ORIGIN = 'http://crm.test';
const OP = '00000000-0000-4000-8000-0000000000a1';
let db: TestDb;

const ctx = { params: Promise.resolve({}) };
const auditRows = () =>
  db.sql<{ actorId: string; entityId: string; meta: Record<string, unknown> }>`
    SELECT actor_id, entity_id, meta FROM audit_log WHERE action = 'user.outbox_expired' ORDER BY created_at, id`;

async function session(as: string | null, author?: string) {
  actAs(as);
  const res = await GET(new Request(`${ORIGIN}/api/device/session`, { headers: author === undefined ? {} : { 'x-call-author': author } }), ctx);
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function expiredReply(as: string | null, body: unknown, headers: Record<string, string> = {}) {
  actAs(as);
  const res = await POST(
    new Request(`${ORIGIN}/api/device/outbox-expired`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    ctx,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
/** Запись журнала о потере данного opId (порядок строк одной миллисекунды не задан — ищем по opId). */
const rowWith = async (op: string) => (await auditRows()).filter((r) => ((r.meta.claimed as { opIds?: string[] } | undefined)?.opIds ?? []).includes(op));
const expired = async (as: string | null, body: unknown, headers: Record<string, string> = {}) => (await expiredReply(as, body, headers)).status;

/** Звонок, который уже дошёл до сервера: id = opId устройства. */
async function receivedCall(id: string): Promise<void> {
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
               VALUES (${id}, ${SPACE}, ${cardOf('a', 1)}, ${clientOf('a', 1)}, ${U.opA}, 'offline', ${phoneOf('a', 1)}, 'no_answer', 'no_answer', 'applied', ${SEED_NOW}, ${SEED_NOW}, 1)`;
}

before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

test('сверка сессии: тот же сотрудник — 200, другой — 409 wrong_user, без сессии — 401; журнал и device_status не пишутся', async () => {
  const before = (await db.sql<{ n: number }>`SELECT (SELECT count(*) FROM audit_log)::int + (SELECT count(*) FROM device_status)::int AS n`)[0]!.n;
  assert.deepEqual(await session(U.opA, U.opA), { status: 200, body: { ok: true } });
  assert.equal((await session(U.opA)).status, 200, 'без заголовка — сессия как есть');
  const other = await session(U.opB, U.opA);
  assert.equal(other.status, 409);
  assert.equal(other.body?.code, 'wrong_user');
  assert.equal((await session(null, U.opA)).status, 401);
  const after = (await db.sql<{ n: number }>`SELECT (SELECT count(*) FROM audit_log)::int + (SELECT count(*) FROM device_status)::int AS n`)[0]!.n;
  assert.equal(after, before);
});

test('потеря итогов: одна запись журнала — автор B, объект A; meta: заявлено телефоном и проверено сервером; ответ без подробностей', async () => {
  await db.sql`INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at) VALUES (${U.opA}, 'dev-exp-1', 2, NULL, ${SEED_NOW})`;
  const reply = await expiredReply(U.opB, { authorId: U.opA, opIds: [OP, OP] }, { 'x-device-id': 'dev-exp-1' });
  assert.deepEqual(reply, { status: 200, body: { ok: true } });
  const rows = await auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, U.opB);
  assert.equal(rows[0]!.entityId, U.opA);
  assert.deepEqual(rows[0]!.meta, {
    // Счётчик по id устройства из заголовка телефона — заявление, а не проверка (D-311)
    claimed: { count: 1, opIds: [OP], reason: 'expired', deviceId: 'dev-exp-1', authorPendingOnDevice: 2 },
    checked: { authorExists: true, alreadyReceived: 0, alreadyClaimed: 0 },
  });
});

test('потеря итогов — мутация безопасности (D-054, D-308): лицензия read_only, invalid, missing и роль «только чтение» — 200 и запись журнала', async () => {
  const locked: LicenseState[] = ['read_only', 'invalid', 'missing'];
  try {
    for (const license of locked) {
      enterSeedWorld({ license });
      const n = (await auditRows()).length;
      const op = uuid();
      assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [op] }, { 'x-device-id': `dev-lic-${license}` }), 200, license);
      assert.equal((await auditRows()).length, n + 1, license);
      assert.equal((await rowWith(op)).length, 1, license);
    }
  } finally {
    enterSeedWorld();
  }
  const n = (await auditRows()).length;
  assert.equal(await expired(U.director, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': 'dev-dir' }), 200, 'директор — роль «только чтение»');
  assert.equal((await auditRows()).length, n + 1);
});

test('потеря итогов: автор — не сотрудник установки → 404 с тем же телом, что у несуществующего объекта; журнал не растёт', async () => {
  const n = (await auditRows()).length;
  const reply = await expiredReply(U.opB, { authorId: 'not-a-user', opIds: [uuid()] }, { 'x-device-id': 'dev-404' });
  assert.deepEqual(reply, { status: 404, body: { error: 'not_found' } });
  assert.equal((await auditRows()).length, n);
});

test('потеря итогов: opId, уже записанные звонками, отбрасываются; дошли все — журнал не пишется', async () => {
  const got = uuid();
  const lost = uuid();
  await receivedCall(got);
  const n = (await auditRows()).length;
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [got] }, { 'x-device-id': 'dev-recv' }), 200);
  assert.equal((await auditRows()).length, n, 'итог дошёл — потери нет');
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [got, lost] }, { 'x-device-id': 'dev-recv' }), 200);
  assert.equal((await auditRows()).length, n + 1);
  const rows = await rowWith(lost);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.meta, {
    claimed: { count: 1, opIds: [lost], reason: 'expired', deviceId: 'dev-recv', authorPendingOnDevice: null },
    checked: { authorExists: true, alreadyReceived: 1, alreadyClaimed: 0 },
  });
});

test('потеря итогов: частота ограничена по сотруднику и устройству (429), другое устройство — до общего предела сотрудника', async () => {
  const { perDevice, perUser } = EXPIRED_REPORT_LIMITS;
  assert.ok(perDevice < perUser);
  const n = (await auditRows()).length;
  for (let i = 0; i < perDevice; i++) assert.equal(await expired(U.rop, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': 'dev-rate-1' }), 200);
  const limited = await expiredReply(U.rop, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': 'dev-rate-1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body?.error, 'rate_limited');
  // Несуществующий автор тоже расходует попытки: перебор id не обходит предел
  assert.equal(await expired(U.rop, { authorId: 'not-a-user', opIds: [uuid()] }, { 'x-device-id': 'dev-rate-1' }), 429);
  // Новое устройство того же сотрудника работает, пока не исчерпан общий предел сотрудника
  let sent = perDevice;
  for (let d = 2; sent < perUser; d++) {
    for (let i = 0; i < perDevice && sent < perUser; i++, sent++) {
      assert.equal(await expired(U.rop, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': `dev-rate-${d}` }), 200);
    }
  }
  assert.equal(await expired(U.rop, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': 'dev-rate-fresh' }), 429);
  assert.equal((await auditRows()).length, n + perUser);
  // Другой сотрудник не затронут
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [uuid()] }, { 'x-device-id': 'dev-rate-1' }), 200);
});

test('потеря своих итогов (D-309): вошёл сам автор — 200 и запись журнала, автор и объект — он сам; уже дошедшие отбрасываются', async () => {
  const lost = uuid();
  const got = uuid();
  await receivedCall(got);
  const reply = await expiredReply(U.opA, { authorId: U.opA, opIds: [lost, got] }, { 'x-device-id': 'dev-own' });
  assert.deepEqual(reply, { status: 200, body: { ok: true } });
  const rows = await rowWith(lost);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, U.opA);
  assert.equal(rows[0]!.entityId, U.opA);
  assert.deepEqual(rows[0]!.meta, {
    claimed: { count: 1, opIds: [lost], reason: 'expired', deviceId: 'dev-own', authorPendingOnDevice: null },
    checked: { authorExists: true, alreadyReceived: 1, alreadyClaimed: 0 },
  });
  // Все дошли — записи нет, как и для чужих
  const n = (await auditRows()).length;
  assert.equal(await expired(U.opA, { authorId: U.opA, opIds: [got] }, { 'x-device-id': 'dev-own' }), 200);
  assert.equal((await auditRows()).length, n);
});

test('потеря итогов: мусор — 400, без сессии — 401; журнал не растёт', async () => {
  const n = (await auditRows()).length;
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: ['не-uuid'] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [OP], note: 'Синтетик' }), 400);
  assert.equal(await expired(null, { authorId: U.opA, opIds: [OP] }), 401);
  assert.equal((await auditRows()).length, n);
});

test('журнал потерь идемпотентен (D-311): повтор того же сообщения не пишет вторую строку; новые opId — только они', async () => {
  const [a, b, c] = [uuid(), uuid(), uuid()];
  const headers = { 'x-device-id': 'dev-idem' };
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [a, b] }, headers), 200);
  const n = (await auditRows()).length;
  // Ответ потерян, телефон повторил; вторая вкладка прислала то же — строк не прибавилось
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [a, b] }, headers), 200);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [b, a] }, headers), 200);
  assert.equal((await auditRows()).length, n);
  // Другой сотрудник о тех же итогах — тоже не дубль: потеря одна
  assert.equal(await expired(U.consultant, { authorId: U.opA, opIds: [a] }, { 'x-device-id': 'dev-idem-2' }), 200);
  assert.equal((await auditRows()).length, n);
  // Вперемешку со старыми — пишутся только новые
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [a, c] }, headers), 200);
  assert.equal((await auditRows()).length, n + 1);
  const rows = await rowWith(c);
  assert.equal(rows.length, 1);
  assert.deepEqual((rows[0]!.meta.claimed as { opIds: string[] }).opIds, [c]);
  assert.deepEqual(rows[0]!.meta.checked, { authorExists: true, alreadyReceived: 0, alreadyClaimed: 1 });
  for (const op of [a, b]) assert.equal((await rowWith(op)).length, 1, op);
});

test('журнал потерь идемпотентен (D-311): сообщения об одном авторе пишутся по очереди — пока одно держит блокировку, второе ждёт и не задваивает', async () => {
  const ops = [uuid(), uuid()];
  const n = (await auditRows()).length;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  // Первая «вкладка» внутри своей транзакции взяла блокировку автора и ещё не записала строку
  const first = db.tx(async (sql) => {
    await lockExpiredClaims(sql, U.opA);
    locked();
    await held;
  });
  await isLocked;
  let secondDone = false;
  const second = expired(U.opB, { authorId: U.opA, opIds: ops }, { 'x-device-id': 'dev-race-1' }).then((s) => ((secondDone = true), s));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(secondDone, false, 'второе сообщение ждёт блокировку автора');
  release();
  await first;
  assert.equal(await second, 200);
  // Одновременные одинаковые сообщения (две вкладки, разные сотрудники) — одна строка
  const replies = await Promise.all(
    Array.from({ length: 6 }, (_, i) => expired(i % 2 ? U.opB : U.consultant, { authorId: U.opA, opIds: ops }, { 'x-device-id': `dev-race-${i}` })),
  );
  assert.deepEqual(replies, [200, 200, 200, 200, 200, 200]);
  assert.equal((await auditRows()).length, n + 1);
  for (const op of ops) assert.equal((await rowWith(op)).length, 1);
});

test('явное удаление своих итогов при выходе (D-311): reason discarded в заявлении; иная причина — 400', async () => {
  const op = uuid();
  assert.equal(await expired(U.opA, { authorId: U.opA, opIds: [op], reason: 'discarded' }, { 'x-device-id': 'dev-disc' }), 200);
  const [row] = await rowWith(op);
  assert.equal(row!.actorId, U.opA);
  assert.equal((row!.meta.claimed as { reason: string }).reason, 'discarded');
  assert.equal(await expired(U.opA, { authorId: U.opA, opIds: [uuid()], reason: 'lost' }, { 'x-device-id': 'dev-disc' }), 400);
});

test('ложное заявление (D-311): B заявил потерю реального итога A, итог потом дошёл — запись опровергнута; не дошедший к сроку — подтверждён', async () => {
  const since = (await db.sql<{ t: number }>`SELECT COALESCE(max(created_at), 0)::bigint AS t FROM audit_log`)[0]!.t;
  const real = uuid();
  const invented = uuid();
  const lost = uuid();
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [real, invented] }, { 'x-device-id': 'dev-forge' }), 200);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [lost] }, { 'x-device-id': 'dev-forge' }), 200);
  const mine = (losses: Awaited<ReturnType<typeof verifyExpiredLosses>>, op: string) => losses.find((l) => [...l.verdict.delivered, ...l.verdict.notDelivered, ...l.verdict.unverified].includes(op))!;
  const sys = systemActor('test', Date.now());
  // Сразу после записи — только заявление телефона
  let losses = await verifyExpiredLosses(sys, { since: Number(since) + 1 }, Date.now());
  assert.equal(mine(losses, real).status, 'claimed');
  assert.equal(mine(losses, real).actorId, U.opB);
  assert.equal(mine(losses, real).authorId, U.opA);
  // A вошёл, его итог дошёл
  await receivedCall(real);
  losses = await verifyExpiredLosses(sys, { since: Number(since) + 1 }, Date.now());
  assert.equal(mine(losses, real).status, 'partly_refuted');
  assert.deepEqual(mine(losses, real).verdict.delivered, [real]);
  // Срок проверки прошёл: дошедший — опровергнут, недошедшие — «итога нет», запись про один дошедший — опровергнута
  const later = Date.now() + EXPIRED_CHECK_AFTER_MS + 1;
  losses = await verifyExpiredLosses(sys, { since: Number(since) + 1 }, later);
  assert.deepEqual(mine(losses, real).verdict, { delivered: [real], notDelivered: [invented], unverified: [] });
  assert.equal(mine(losses, lost).status, 'confirmed');
  await receivedCall(lost);
  losses = await verifyExpiredLosses(sys, { since: Number(since) + 1 }, later);
  assert.equal(mine(losses, lost).status, 'refuted', 'дошедший и после срока опровергает запись');
});
