// Единый HMAC номера и ИИН: значения совпадают с прежними реализациями, в production без ключа — ошибка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { iinHmac, phoneHmac } from '../../../src/server/platform/hmac';

const ref = (key: string, v: string): string => createHmac('sha256', key).update(v).digest('hex');

test('значения совпадают с прежними (dev-ключи и заданные ключи)', () => {
  assert.equal(phoneHmac('77091234567', {}), ref('dev-only-phone-hmac-key', '77091234567'));
  assert.equal(iinHmac('900101300123', {}), ref('dev-only-iin-hmac-key', '900101300123'));
  assert.equal(phoneHmac('77091234567', { CRM_PHONE_HMAC_KEY: 'k1' }), ref('k1', '77091234567'));
  assert.equal(iinHmac('900101300123', { CRM_IIN_HMAC_KEY: 'k2' }), ref('k2', '900101300123'));
});

test('production без ключа — ошибка', () => {
  assert.throws(() => phoneHmac('77091234567', { NODE_ENV: 'production' }), /CRM_PHONE_HMAC_KEY/);
  assert.throws(() => iinHmac('900101300123', { NODE_ENV: 'production' }), /CRM_IIN_HMAC_KEY/);
});
