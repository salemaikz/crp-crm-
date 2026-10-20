// Статус устройства (D-063, D-178): заголовки запроса → строка device_status; старый запрос не перетирает новый.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { parseDeviceHeaders, purgeDeviceStatus, recordDeviceStatus } from '../../../src/server/domain/calls/device';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { SEED_NOW, closeCallsWorld, openCallsWorld, viewerOf } from './world';

let db: TestDb;
let opA: Viewer;

const rows = () => db.sql<{ userId: string; deviceId: string; pendingOutbox: number; lastFlushAt: number | null; seenAt: number }>`SELECT * FROM device_status ORDER BY device_id`;

before(async () => {
  db = await openCallsWorld();
  opA = await viewerOf(U.opA);
});
after(() => closeCallsWorld(db));

test('заголовки → строка device_status; обновление меняет счётчик и время', async () => {
  const h = new Headers({ 'x-device-id': 'dev-1', 'x-outbox-pending': '4', 'x-outbox-last-flush': String(SEED_NOW - 1000) });
  await recordDeviceStatus(opA, parseDeviceHeaders(h)!, SEED_NOW);
  assert.deepEqual((await rows()).map((r) => [r.userId, r.deviceId, r.pendingOutbox, r.lastFlushAt, r.seenAt]), [[U.opA, 'dev-1', 4, SEED_NOW - 1000, SEED_NOW]]);
  await recordDeviceStatus(opA, { deviceId: 'dev-1', pending: 0, lastFlushAt: null }, SEED_NOW + 10);
  const r = (await rows())[0]!;
  assert.deepEqual([r.pendingOutbox, r.lastFlushAt, r.seenAt], [0, SEED_NOW - 1000, SEED_NOW + 10], 'пустая «последняя отправка» прежнюю не стирает');
});

test('старый запрос после нового не перетирает', async () => {
  await recordDeviceStatus(opA, { deviceId: 'dev-2', pending: 7, lastFlushAt: null }, SEED_NOW + 100);
  await recordDeviceStatus(opA, { deviceId: 'dev-2', pending: 1, lastFlushAt: null }, SEED_NOW + 50);
  const r = (await rows()).find((x) => x.deviceId === 'dev-2')!;
  assert.deepEqual([r.pendingOutbox, r.seenAt], [7, SEED_NOW + 100]);
});

test('без заголовков и с мусором ничего не пишется', async () => {
  const before = (await rows()).length;
  assert.equal(parseDeviceHeaders(new Headers()), null);
  assert.equal(parseDeviceHeaders(new Headers({ 'x-device-id': 'x', 'x-outbox-pending': 'many' })), null);
  assert.equal((await rows()).length, before);
});

test('ошибка записи не бросается в запрос (только в лог)', async () => {
  const err = console.error;
  console.error = () => {};
  try {
    // отрицательный счётчик нарушает CHECK: запись не проходит, исключения наружу нет
    await recordDeviceStatus(opA, { deviceId: 'dev-3', pending: -5, lastFlushAt: null }, SEED_NOW);
  } finally {
    console.error = err;
  }
  assert.equal((await rows()).some((r) => r.deviceId === 'dev-3'), false);
});

test('purge: старше порога удаляются, свежие остаются', async () => {
  const removed = await purgeDeviceStatus({ kind: 'system', job: 'purge', now: SEED_NOW }, SEED_NOW + 60);
  assert.ok(removed >= 1);
  assert.deepEqual((await rows()).map((r) => r.deviceId), ['dev-2']);
});
