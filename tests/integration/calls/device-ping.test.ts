// Пинг устройства POST /api/device/ping (D-063, calls-design §10): строка device_status из заголовков и сессии;
// без сессии — отказ; мусор в заголовках — 400 и ничего не пишется; чужой пользователь чужую строку не трогает.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../../src/app/api/device/ping/route';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { actAs } from '../../isolation/harness/actors';
import { SEED_NOW, closeCallsWorld, openCallsWorld } from './world';

const ORIGIN = 'http://crm.test';
let db: TestDb;

const rows = () => db.sql<{ userId: string; deviceId: string; pendingOutbox: number; lastFlushAt: number | null }>`SELECT * FROM device_status ORDER BY user_id, device_id`;

async function ping(as: string | null, headers: Record<string, string>) {
  actAs(as);
  const res = await POST(new Request(`${ORIGIN}/api/device/ping`, { method: 'POST', headers: { origin: ORIGIN, ...headers } }), { params: Promise.resolve({}) });
  return res.status;
}

before(async () => {
  db = await openCallsWorld();
});
after(() => closeCallsWorld(db));

test('пинг пишет pending из X-Outbox-Pending на сессию вызвавшего', async () => {
  const status = await ping(U.opA, { 'x-device-id': 'dev-ping-1', 'x-outbox-pending': '3', 'x-outbox-last-flush': String(SEED_NOW - 5000) });
  assert.equal(status, 200);
  const r = (await rows()).find((x) => x.deviceId === 'dev-ping-1')!;
  assert.deepEqual([r.userId, r.pendingOutbox, r.lastFlushAt], [U.opA, 3, SEED_NOW - 5000]);
});

test('второй пинг обновляет счётчик; чужой пользователь с тем же device_id пишет свою строку', async () => {
  assert.equal(await ping(U.opA, { 'x-device-id': 'dev-ping-1', 'x-outbox-pending': '0' }), 200);
  assert.equal(await ping(U.opB, { 'x-device-id': 'dev-ping-1', 'x-outbox-pending': '9' }), 200);
  const mine = (await rows()).filter((x) => x.deviceId === 'dev-ping-1');
  assert.deepEqual(mine.map((x) => [x.userId, x.pendingOutbox]).sort(), [[U.opA, 0], [U.opB, 9]].sort());
});

test('нет заголовков или мусор → 400, строка не пишется; без сессии — отказ', async () => {
  const n = (await rows()).length;
  assert.equal(await ping(U.opA, {}), 400);
  assert.equal(await ping(U.opA, { 'x-device-id': 'dev-ping-2', 'x-outbox-pending': 'many' }), 400);
  assert.equal(await ping(U.opA, { 'x-device-id': 'dev-ping-2', 'x-outbox-pending': '10001' }), 400);
  assert.equal((await rows()).length, n);
  assert.ok([401, 403].includes(await ping(null, { 'x-device-id': 'dev-ping-3', 'x-outbox-pending': '1' })));
});
