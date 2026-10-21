// Сверка сессии вкладки GET /api/device/session (D-292) и сообщение о потере итогов POST /api/device/outbox-expired
// (D-293 п. 2, D-308). Сверка ничего не пишет. Потеря — мутация безопасности: работает при любой лицензии и для роли
// «только чтение» (ПДн уходят с общего телефона). Журнал пишется только о существующем сотруднике и только об opId,
// которых нет среди звонков; в meta раздельно «заявлено телефоном» и «подтверждено сервером»; частота ограничена.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../../src/app/api/device/session/route';
import { POST } from '../../../src/app/api/device/outbox-expired/route';
import { EXPIRED_REPORT_LIMITS } from '../../../src/server/domain/calls';
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

test('потеря итогов: одна запись журнала — автор B, объект A; meta: заявлено телефоном и подтверждено сервером; ответ без подробностей', async () => {
  await db.sql`INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at) VALUES (${U.opA}, 'dev-exp-1', 2, NULL, ${SEED_NOW})`;
  const reply = await expiredReply(U.opB, { authorId: U.opA, opIds: [OP, OP] }, { 'x-device-id': 'dev-exp-1' });
  assert.deepEqual(reply, { status: 200, body: { ok: true } });
  const rows = await auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, U.opB);
  assert.equal(rows[0]!.entityId, U.opA);
  assert.deepEqual(rows[0]!.meta, {
    claimed: { count: 1, opIds: [OP], deviceId: 'dev-exp-1' },
    confirmed: { authorExists: true, alreadyReceived: 0, authorPendingOnDevice: 2 },
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
    claimed: { count: 1, opIds: [lost], deviceId: 'dev-recv' },
    confirmed: { authorExists: true, alreadyReceived: 1, authorPendingOnDevice: null },
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

test('потеря итогов: свои — 400, мусор — 400, без сессии — 401; журнал не растёт', async () => {
  const n = (await auditRows()).length;
  assert.equal(await expired(U.opA, { authorId: U.opA, opIds: [OP] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: ['не-uuid'] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [OP], note: 'Синтетик' }), 400);
  assert.equal(await expired(null, { authorId: U.opA, opIds: [OP] }), 401);
  assert.equal((await auditRows()).length, n);
});
