// Сверка сессии вкладки GET /api/device/session (D-292) и сообщение о потере итогов POST /api/device/outbox-expired
// (D-293 п. 2). Сверка ничего не пишет; потеря — одна строка журнала от имени вызвавшего, без ПДн; свои итоги так не
// удаляются; «только чтение» мутацию блокирует (итог тогда остаётся на телефоне).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../../src/app/api/device/session/route';
import { POST } from '../../../src/app/api/device/outbox-expired/route';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { actAs } from '../../isolation/harness/actors';
import { closeCallsWorld, openCallsWorld } from './world';

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

async function expired(as: string | null, body: unknown, headers: Record<string, string> = {}) {
  actAs(as);
  const res = await POST(
    new Request(`${ORIGIN}/api/device/outbox-expired`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    ctx,
  );
  return res.status;
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

test('потеря итогов: одна запись журнала — автор B, объект A, число и opId, id устройства; без ПДн', async () => {
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [OP, OP] }, { 'x-device-id': 'dev-exp-1' }), 200);
  const rows = await auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actorId, U.opB);
  assert.equal(rows[0]!.entityId, U.opA);
  assert.deepEqual(rows[0]!.meta, { count: 1, opIds: [OP], deviceId: 'dev-exp-1' });
});

test('потеря итогов: свои — 400, мусор — 400, без сессии — 401, «только чтение» — 423; журнал не растёт', async () => {
  const n = (await auditRows()).length;
  assert.equal(await expired(U.opA, { authorId: U.opA, opIds: [OP] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: ['не-uuid'] }), 400);
  assert.equal(await expired(U.opB, { authorId: U.opA, opIds: [OP], note: 'Синтетик' }), 400);
  assert.equal(await expired(null, { authorId: U.opA, opIds: [OP] }), 401);
  assert.equal(await expired(U.director, { authorId: U.opA, opIds: [OP] }), 423);
  assert.equal((await auditRows()).length, n);
});
