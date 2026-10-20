// Выбор мастера записи: тела запросов и разбор ответов (B3a, docs/booking-wizard-design.md §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgreementBookingBody, BookingBody } from '../../../src/app/api/bookings/_lib';
import { toAgreementBooking, toBookingBody, type WizardChoice } from '../../../src/app/(op)/bookings/_wizard/choice';
import { formatChipDay, formatDay, formatWhen } from '../../../src/app/(op)/bookings/_wizard/format';
import { parseBookingResponse } from '../../../src/app/(op)/bookings/_wizard/result';

const KEY = '00000000-0000-4000-8000-0000000000b1';
const event = {
  id: 'ev-1',
  eventTypeKey: 'br',
  eventDate: '2026-10-29',
  startTime: '15:00',
  startsAt: 0,
  durationMin: 180,
  location: 'Зал 1',
  format: 'offline' as const,
  seats: { capacity: 30, taken: 18, left: 12 },
};
const group: WizardChoice = { kind: 'group', eventTypeKey: 'br', event };
const consult: WizardChoice = { kind: 'individual', eventTypeKey: 'bk', directionKey: 'marketing', date: '2026-10-26', time: '09:45' };
const view = { clientId: 'cl-1' };

test('toBookingBody: групповая и заявка проходят схему POST /api/bookings', () => {
  assert.deepEqual(toBookingBody(view, group, KEY), { kind: 'group', requestId: KEY, clientId: 'cl-1', eventId: 'ev-1', contactId: null });
  const body = toBookingBody(view, consult, KEY);
  assert.equal(body.resourceId, null);
  assert.equal(BookingBody.safeParse(toBookingBody(view, group, KEY)).success, true);
  assert.equal(BookingBody.safeParse(body).success, true);
});

test('toAgreementBooking: без requestId, клиента и контакта; проходит схему итога', () => {
  assert.deepEqual(toAgreementBooking(group), { kind: 'group', eventId: 'ev-1' });
  const a = toAgreementBooking(consult);
  assert.equal('requestId' in a || 'clientId' in a || 'contactId' in a, false);
  assert.equal(AgreementBookingBody.safeParse(a).success, true);
  assert.equal(AgreementBookingBody.safeParse(toAgreementBooking(group)).success, true);
});

test('схема тела: resourceId строкой и лишние поля отклоняются', () => {
  const ok = toBookingBody(view, consult, KEY);
  assert.equal(BookingBody.safeParse({ ...ok, resourceId: 'r1' }).success, false);
  assert.equal(BookingBody.safeParse({ ...ok, extra: 1 }).success, false);
  assert.equal(BookingBody.safeParse({ ...ok, kind: 'other' }).success, false);
});

test('parseBookingResponse: 201 и 200 (повтор ключа) → ok', () => {
  const booking = { id: 'b1', version: 0 };
  assert.deepEqual(parseBookingResponse(201, { action: 'created', booking, replayed: false }), { ok: true, booking, action: 'created' });
  assert.deepEqual(parseBookingResponse(200, { action: 'moved', booking, movedFromId: 'b0', replayed: true }), { ok: true, booking, action: 'moved' });
});

test('parseBookingResponse: 409 event_full несёт альтернативы из ответа', () => {
  const r = parseBookingResponse(409, { error: 'conflict', detail: 'event_full', alternatives: [event] });
  assert.deepEqual(r, { ok: false, code: 'event_full', alternatives: [event] });
  assert.deepEqual(parseBookingResponse(409, { error: 'conflict', detail: 'event_full' }), { ok: false, code: 'event_full', alternatives: [] });
});

test('parseBookingResponse: 409 с кодом, 5xx и мусор', () => {
  assert.deepEqual(parseBookingResponse(409, { error: 'conflict', detail: 'outcome_required' }), { ok: false, code: 'outcome_required' });
  assert.deepEqual(parseBookingResponse(409, { error: 'conflict', detail: 'outside_hours' }), { ok: false, code: 'outside_hours' });
  assert.deepEqual(parseBookingResponse(500, { error: 'internal' }), { ok: false, code: 'network' });
  assert.deepEqual(parseBookingResponse(503, null), { ok: false, code: 'network' });
  assert.deepEqual(parseBookingResponse(200, 'не json-объект'), { ok: false, code: 'network' });
});

test('format: календарная дата без сдвига пояса', () => {
  assert.equal(formatDay('2026-10-29', 'ru'), 'чт, 29 окт.');
  assert.equal(formatWhen('2026-10-29', '15:00', 'ru'), 'чт, 29 окт., 15:00');
  assert.equal(formatChipDay('2026-10-26', 'ru'), 'пн 26');
});
