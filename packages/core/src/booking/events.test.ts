/**
 * Групповые мероприятия: места, предложение ближайших, проверка записи, перенос вместо второй записи.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bookingsToCancelOnEventCancel, countTaken, eventBookability, offerEvents, resolveRepeatBooking, seats, type ClientBookingLite,
  type EventWithTaken,
} from './events';
import { localToEpoch } from './time';
import { TZ } from './fixtures';

const NOW = localToEpoch(TZ, '2026-10-20', '10:00');

function ev(id: string, date: string, taken: number, p: Partial<EventWithTaken> = {}): EventWithTaken {
  return {
    id, seriesId: 's1', eventTypeKey: 'group_event', eventDate: date, startTime: '15:00', startsAt: localToEpoch(TZ, date, '15:00'),
    durationMin: 180, location: '', format: 'offline', capacity: 30, status: 'scheduled', occurrenceKey: null, touched: false, taken, ...p,
  };
}

test('места: «осталось 12 из 30»; переполнение не уходит в минус', () => {
  assert.deepEqual(seats(30, 18), { capacity: 30, taken: 18, left: 12 });
  assert.equal(seats(30, 31).left, 0);
});

test('место держат registered/confirmed/attended/no_show; отмена и перенос освобождают', () => {
  assert.equal(countTaken(['registered', 'confirmed', 'attended', 'no_show', 'cancelled', 'moved']), 4);
});

test('нельзя: на отменённое, на начавшееся, при полном зале', () => {
  const e = ev('e', '2026-10-22', 0);
  assert.deepEqual(eventBookability(e, 5, NOW), { ok: true });
  assert.deepEqual(eventBookability({ ...e, status: 'cancelled' }, 0, NOW), { ok: false, reason: 'event_cancelled' });
  assert.deepEqual(eventBookability({ ...e, startsAt: NOW - 1 }, 0, NOW), { ok: false, reason: 'event_in_past' });
  assert.deepEqual(eventBookability(e, 30, NOW), { ok: false, reason: 'event_full' });
  assert.deepEqual(eventBookability(e, 29, NOW), { ok: true }, 'последнее место ещё можно');
});

test('мастер: ближайшие groupOptions мероприятий с местами, полные и отменённые пропускаются', () => {
  const list = [
    ev('e5', '2026-11-12', 0),
    ev('e1', '2026-10-22', 30), // полное
    ev('e2', '2026-10-29', 3),
    ev('e0', '2026-10-15', 0), // прошло
    ev('e3', '2026-11-05', 0, { status: 'cancelled' }),
    ev('e4', '2026-11-05', 10, { id: 'e4b' }),
    ev('e6', '2026-11-19', 0),
  ];
  assert.deepEqual(offerEvents(list, NOW, 3).map((e) => e.id), ['e2', 'e4b', 'e5']);
  assert.deepEqual(offerEvents(list, NOW, 0), []);
  assert.deepEqual(offerEvents(list, NOW, 3, 'other_type'), [], 'фильтр по виду');
});

const mine = (id: string, status: ClientBookingLite['status'], date: string, eventId: string | null, p: Partial<ClientBookingLite> = {}): ClientBookingLite => ({
  id, status, eventTypeKey: 'group_event', eventId, startsAt: localToEpoch(TZ, date, '15:00'), bookedByUserId: 'u-1', ...p,
});
const target = { eventTypeKey: 'group_event', eventId: 'e-new' };

test('повторная запись на будущее при активной будущей = перенос; автор исходной сохраняется', () => {
  const d = resolveRepeatBooking([mine('b1', 'registered', '2026-10-22', 'e-old', { bookedByUserId: 'u-author' })], target, NOW);
  assert.deepEqual(d, { action: 'move', fromBookingId: 'b1', bookedByUserId: 'u-author' });
  assert.equal(resolveRepeatBooking([mine('b1', 'confirmed', '2026-10-22', 'e-old')], target, NOW).action, 'move');
});

test('второй раз на то же мероприятие — отказ', () => {
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'confirmed', '2026-10-29', 'e-new')], target, NOW), { action: 'reject', reason: 'already_registered' });
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'no_show', '2026-10-29', 'e-new')], target, NOW), { action: 'reject', reason: 'already_registered' });
});

test('отменённая или перенесённая запись на то же мероприятие не мешает записаться снова', () => {
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'cancelled', '2026-10-29', 'e-new')], target, NOW), { action: 'create' });
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'moved', '2026-10-29', 'e-new')], target, NOW), { action: 'create' });
});

test('прошедшая, чужого вида и отмеченная запись переносом не становятся', () => {
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'registered', '2026-10-15', 'e-old')], target, NOW), { action: 'create' }, 'прошла');
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'registered', '2026-10-22', 'e-old', { eventTypeKey: 'consultation' })], target, NOW), { action: 'create' }, 'другой вид');
  assert.deepEqual(resolveRepeatBooking([mine('b1', 'attended', '2026-10-22', 'e-old')], target, NOW), { action: 'create' }, 'уже пришёл');
  assert.deepEqual(resolveRepeatBooking([], target, NOW), { action: 'create' });
});

test('из нескольких активных переносится ближайшая', () => {
  const d = resolveRepeatBooking(
    [mine('late', 'registered', '2026-11-05', 'e-x'), mine('soon', 'registered', '2026-10-22', 'e-y')],
    target,
    NOW,
  );
  assert.equal(d.action === 'move' && d.fromBookingId, 'soon');
});

test('отмена мероприятия затрагивает только активные записи', () => {
  const rows = (['registered', 'confirmed', 'attended', 'no_show', 'cancelled', 'moved'] as const).map((status) => ({ status }));
  assert.deepEqual(bookingsToCancelOnEventCancel(rows).map((r) => r.status), ['registered', 'confirmed']);
});
