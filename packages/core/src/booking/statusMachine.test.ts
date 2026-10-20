/**
 * Автомат статусов записи (PROCESS §5.3): по тесту на каждую строку таблицы и каждое правило времени.
 * Сдвиг на пять часов превращает «четверг 15:00» в «четверг 10:00», а разрешённый «пришёл» до начала —
 * в отчёт о явке, которой не было.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allowedTargets, autoNoShowDue, checkTransition, isAttendanceCorrection, isMove } from './statusMachine';
import { BOOKING_STATUSES, isActive, isOccupying, type BookingStatus } from './types';
import { localToEpoch } from './time';
import { HOUR, MIN, TZ, testCalendar } from './fixtures';

const START = localToEpoch(TZ, '2026-10-22', '15:00');
const ctx = (now: number, extra: { lateCorrection?: boolean } = {}) => ({ tz: TZ, now, startsAt: START, durationMin: 180, ...extra });

const sorted = (xs: readonly BookingStatus[]) => [...xs].sort();

test('таблица переходов §5.3: допустимые цели каждого статуса', () => {
  assert.deepEqual(sorted(allowedTargets('registered')), ['attended', 'cancelled', 'confirmed', 'moved', 'no_show']);
  assert.deepEqual(sorted(allowedTargets('confirmed')), ['attended', 'cancelled', 'moved', 'no_show', 'registered']);
  assert.deepEqual(sorted(allowedTargets('no_show')), ['attended', 'cancelled', 'moved']);
  assert.deepEqual(sorted(allowedTargets('attended')), ['no_show']);
  assert.deepEqual(sorted(allowedTargets('cancelled')), ['registered']);
  assert.deepEqual(allowedTargets('moved'), []);
});

test('перенесённая запись конечна: жизнь продолжается в новой', () => {
  for (const to of BOOKING_STATUSES) {
    assert.equal(checkTransition('moved', to, ctx(START - HOUR)).ok, false, `moved → ${to}`);
  }
  assert.equal(isMove('moved'), true);
  assert.equal(isMove('cancelled'), false);
});

test('запрещённые пары — invalid_transition, а не молчаливый ok', () => {
  assert.deepEqual(checkTransition('attended', 'cancelled', ctx(START + HOUR)), { ok: false, reason: 'invalid_transition' });
  assert.deepEqual(checkTransition('cancelled', 'attended', ctx(START + HOUR)), { ok: false, reason: 'invalid_transition' });
  assert.deepEqual(checkTransition('no_show', 'confirmed', ctx(START + HOUR)), { ok: false, reason: 'invalid_transition' });
  assert.deepEqual(checkTransition('cancelled', 'moved', ctx(START - HOUR)), { ok: false, reason: 'invalid_transition' });
});

test('тот же статус — отдельная причина, а не «запрещённый переход»', () => {
  assert.deepEqual(checkTransition('confirmed', 'confirmed', ctx(START - HOUR)), { ok: false, reason: 'same_status' });
});

test('registered → confirmed | moved | cancelled: до начала можно', () => {
  for (const to of ['confirmed', 'moved', 'cancelled'] as const) {
    assert.deepEqual(checkTransition('registered', to, ctx(START - 20 * HOUR)), { ok: true }, to);
  }
});

test('«пришёл» — с начала суток мероприятия, но не накануне', () => {
  const dayBefore = localToEpoch(TZ, '2026-10-21', '18:00');
  const morning = localToEpoch(TZ, '2026-10-22', '08:00');
  assert.deepEqual(checkTransition('confirmed', 'attended', ctx(dayBefore)), { ok: false, reason: 'too_early' });
  assert.deepEqual(checkTransition('registered', 'attended', ctx(dayBefore)), { ok: false, reason: 'too_early' });
  assert.deepEqual(checkTransition('confirmed', 'attended', ctx(morning)), { ok: true });
});

test('«не пришёл» — только после начала: до начала человек ещё может прийти', () => {
  assert.deepEqual(checkTransition('confirmed', 'no_show', ctx(START - MIN)), { ok: false, reason: 'too_early' });
  assert.deepEqual(checkTransition('registered', 'no_show', ctx(START - MIN)), { ok: false, reason: 'too_early' });
  assert.deepEqual(checkTransition('confirmed', 'no_show', ctx(START + MIN)), { ok: true });
});

test('подтвердить закончившуюся встречу нельзя; снять подтверждение — тоже', () => {
  const after = START + 4 * HOUR;
  assert.deepEqual(checkTransition('registered', 'confirmed', ctx(after)), { ok: false, reason: 'too_late' });
  assert.deepEqual(checkTransition('confirmed', 'registered', ctx(after)), { ok: false, reason: 'too_late' });
  assert.deepEqual(checkTransition('confirmed', 'registered', ctx(START + HOUR)), { ok: true }, 'идёт — ещё можно');
});

test('не пришёл → пришёл (исправление явки): без ограничения по времени', () => {
  const nextWeek = START + 7 * 24 * HOUR;
  assert.deepEqual(checkTransition('no_show', 'attended', ctx(nextWeek)), { ok: true });
  assert.equal(isAttendanceCorrection('no_show', 'attended'), true);
  assert.equal(isAttendanceCorrection('attended', 'no_show'), false);
});

test('не пришедшему предлагают следующее мероприятие или отмену — перенос и отмена из no_show разрешены', () => {
  assert.equal(checkTransition('no_show', 'moved', ctx(START + 4 * HOUR)).ok, true);
  assert.equal(checkTransition('no_show', 'cancelled', ctx(START + 4 * HOUR)).ok, true);
});

test('пришёл → не пришёл: в течение суток мероприятия; позже только с правом правки задним числом', () => {
  const sameEvening = localToEpoch(TZ, '2026-10-22', '23:00');
  const nextDay = localToEpoch(TZ, '2026-10-23', '09:00');
  assert.deepEqual(checkTransition('attended', 'no_show', ctx(sameEvening)), { ok: true });
  assert.deepEqual(checkTransition('attended', 'no_show', ctx(nextDay)), { ok: false, reason: 'too_late' });
  assert.deepEqual(checkTransition('attended', 'no_show', ctx(nextDay, { lateCorrection: true })), { ok: true });
});

test('отменённую можно вернуть, только пока мероприятие не началось', () => {
  assert.deepEqual(checkTransition('cancelled', 'registered', ctx(START - HOUR)), { ok: true });
  assert.deepEqual(checkTransition('cancelled', 'registered', ctx(START + MIN)), { ok: false, reason: 'too_late' });
});

test('место держат registered/confirmed/attended/no_show; отмена и перенос — нет', () => {
  assert.deepEqual(BOOKING_STATUSES.filter(isOccupying), ['registered', 'confirmed', 'attended', 'no_show']);
  assert.deepEqual(BOOKING_STATUSES.filter(isActive), ['registered', 'confirmed']);
});

// ---------------------------------------------------------------------------
// Автонеявка (attendance-sweep): PROCESS № 28
// ---------------------------------------------------------------------------

// пн–пт; 26.10.2026 — праздничный выходной (перенос).
const calendar = testCalendar([{ date: '2026-10-26', kind: 'holiday' }]);

test('автонеявка: нулевой срок — сама дата мероприятия', () => {
  const b = { status: 'registered' as const, startsAt: START };
  assert.equal(autoNoShowDue(b, localToEpoch(TZ, '2026-10-22', '00:00'), { tz: TZ, workdays: 0, calendar }), true);
});

test('автонеявка: срок — начало суток N-го рабочего дня после мероприятия', () => {
  const opts = { tz: TZ, workdays: 2, calendar };
  const b = { status: 'registered' as const, startsAt: START };
  // чт 22.10 + 2 рабочих дня = вт 27.10 (пт 23.10 — раз, пн 26.10 — праздник, вт — два).
  const due = localToEpoch(TZ, '2026-10-27', '00:00');
  assert.equal(autoNoShowDue(b, due - MIN, opts), false);
  assert.equal(autoNoShowDue(b, due, opts), true);
});

test('автонеявка: выключена (null), отмеченные и отменённые не трогаются', () => {
  const far = START + 30 * 24 * HOUR;
  assert.equal(autoNoShowDue({ status: 'registered', startsAt: START }, far, { tz: TZ, workdays: null, calendar }), false);
  for (const status of ['attended', 'no_show', 'cancelled', 'moved'] as const) {
    assert.equal(autoNoShowDue({ status, startsAt: START }, far, { tz: TZ, workdays: 2, calendar }), false, status);
  }
  assert.equal(autoNoShowDue({ status: 'confirmed', startsAt: START }, far, { tz: TZ, workdays: 2, calendar }), true);
});
