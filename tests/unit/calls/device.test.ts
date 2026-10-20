// Разбор заголовков устройства (D-063, D-178): мусор → null, запрос не ломается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceHeaders } from '../../../src/server/domain/calls/device';

const h = (o: Record<string, string>) => new Headers(o);

test('полный набор заголовков', () => {
  assert.deepEqual(parseDeviceHeaders(h({ 'x-device-id': 'dev_A-1', 'x-outbox-pending': '3', 'x-outbox-last-flush': '1793000000000' })), {
    deviceId: 'dev_A-1',
    pending: 3,
    lastFlushAt: 1_793_000_000_000,
  });
});

test('последняя отправка пустая → null', () => {
  assert.deepEqual(parseDeviceHeaders(h({ 'x-device-id': 'd1', 'x-outbox-pending': '0', 'x-outbox-last-flush': '' })), { deviceId: 'd1', pending: 0, lastFlushAt: null });
  assert.deepEqual(parseDeviceHeaders(h({ 'x-device-id': 'd1', 'x-outbox-pending': '0' })), { deviceId: 'd1', pending: 0, lastFlushAt: null });
});

test('нет id, неверный id, мусорные числа и выход за 10 000 → null', () => {
  assert.equal(parseDeviceHeaders(h({ 'x-outbox-pending': '1' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'bad id!', 'x-outbox-pending': '1' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'a'.repeat(65), 'x-outbox-pending': '1' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd', 'x-outbox-pending': '-1' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd', 'x-outbox-pending': 'abc' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd', 'x-outbox-pending': '10001' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd', 'x-outbox-pending': '5', 'x-outbox-last-flush': 'yesterday' })), null);
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd' })), null);
});

test('граница 10 000 допустима', () => {
  assert.equal(parseDeviceHeaders(h({ 'x-device-id': 'd', 'x-outbox-pending': '10000' }))?.pending, 10_000);
});
