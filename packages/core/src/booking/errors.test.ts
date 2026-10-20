import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BOOKING_ERROR_STATUS, BookingError } from './errors';

test('ошибка несёт машиночитаемый код и HTTP-статус из таблицы', () => {
  const e = new BookingError('event_full');
  assert.equal(e.code, 'event_full');
  assert.equal(e.status, 409);
  assert.equal(e.message, 'event_full');
  assert.equal(new BookingError('booking_not_found', 'нет записи').status, 404);
  assert.equal(new BookingError('invalid_phone').status, 400);
  assert.ok(e instanceof Error);
});

test('таблица статусов: только 400, 404 или 409', () => {
  for (const [code, status] of Object.entries(BOOKING_ERROR_STATUS)) assert.ok([400, 404, 409].includes(status), code);
});
