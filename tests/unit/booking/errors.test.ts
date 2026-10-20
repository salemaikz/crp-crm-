// Ошибки домена записи: код → HTTP и тело ответа (docs/booking-design.md §10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_HTTP_STATUS, BookingDomainError, fromCore, httpFailure } from '../../../src/server/domain/booking/errors';
import { booking } from '../../../packages/core/src';
import { BOOKING_DOMAIN_ERRORS } from '../../../src/server/domain/booking/types';

test('«не найдено» → общий 404 (чужое = несуществующее)', () => {
  for (const code of ['booking_not_found', 'event_not_found', 'series_not_found', 'consultant_not_found'] as const) {
    assert.deepEqual(httpFailure(new BookingDomainError(code)), { kind: 'not_found' });
  }
});

test('конфликты → 409 с кодом; event_full несёт альтернативы, остальные — нет', () => {
  const alt = [{ id: 'e1' }] as never;
  const full = httpFailure(new BookingDomainError('event_full', alt));
  assert.deepEqual(full, { kind: 'response', status: 409, body: { error: 'conflict', detail: 'event_full', alternatives: alt } });
  for (const code of ['event_cancelled', 'event_in_past', 'already_registered', 'invalid_transition', 'same_status', 'too_early', 'too_late', 'outcome_required', 'request_reused', 'event_has_bookings', 'capacity_below_taken', 'invalid_settings'] as const) {
    const f = httpFailure(new BookingDomainError(code, alt));
    assert.deepEqual(f, { kind: 'response', status: 409, body: { error: 'conflict', detail: code } }, code);
  }
});

test('плохой запрос → 400; порт карточки до C5 → 503', () => {
  assert.deepEqual(httpFailure(new BookingDomainError('move_target_required')), { kind: 'bad_request', detail: 'move_target_required' });
  assert.deepEqual(httpFailure(new BookingDomainError('card_port_unavailable')), { kind: 'response', status: 503, body: { error: 'internal', detail: 'card_port_unavailable' } });
});

test('у каждого кода домена есть статус; ошибка ядра сохраняет код', () => {
  for (const code of BOOKING_DOMAIN_ERRORS) assert.ok(BOOKING_HTTP_STATUS[code] >= 400, code);
  const e = fromCore(new booking.BookingError('event_full'));
  assert.equal(e.code, 'event_full');
  assert.equal(e.status, 409);
});
