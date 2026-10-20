// Сетка заявки на консультацию (B3a): полоса дней и проверка слота — одна логика (docs/booking-wizard-design.md §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { booking, time } from '../../../packages/core/src';
import { checkConsultSlot, consultDays, consultDaySlots } from '../../../src/server/domain/booking/consult';
import type { BookingCatalog, BookingSettings } from '../../../src/server/domain/booking/types';

const TZ = 'Asia/Almaty';
const catalog: BookingCatalog = {
  eventTypes: [],
  directions: [],
  consult: { slotMinutes: 45, hours: { workdays: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, stripDays: 7 },
};

function settings(holidays: time.CalendarSettings['holidays'] = []): BookingSettings & { catalog: BookingCatalog } {
  return {
    spaceId: 'sp',
    timeZone: TZ,
    calendar: time.createWorkCalendar({ timezone: TZ, workdays: [1, 2, 3, 4, 5], workHours: { start: '09:00', end: '18:00' }, callWindow: { start: '09:00', end: '18:00' }, holidays }),
    groupTypes: [],
    horizonDays: 28,
    groupOptions: 3,
    seedSeries: [],
    deals: null,
    operatorErrorWindowMin: 10,
    catalog,
  };
}

const at = (date: string, hhmm: string) => booking.localToEpoch(TZ, date, hhmm);

test('день: 12 слотов с шагом 45 минут, последний 17:15', () => {
  const slots = consultDaySlots(settings(), '2026-10-27');
  assert.equal(slots.length, 12);
  assert.deepEqual([slots[0], slots[1], slots[11]], ['09:00', '09:45', '17:15']);
});

test('полоса: 7 рабочих дней, суббота и воскресенье пропущены', () => {
  const days = consultDays(settings(), at('2026-10-27', '08:00'));
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.date), ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04']);
});

test('праздничный день пропущен полосой', () => {
  const days = consultDays(settings([{ date: '2026-10-28', kind: 'holiday' }]), at('2026-10-27', '08:00'));
  assert.ok(!days.some((d) => d.date === '2026-10-28'));
  assert.equal(days.length, 7);
});

test('сегодня в 12:10 первый слот 12:45, последний 17:15', () => {
  const [first] = consultDays(settings(), at('2026-10-27', '12:10'));
  assert.equal(first?.date, '2026-10-27');
  assert.equal(first?.times[0], '12:45');
  assert.equal(first?.times.at(-1), '17:15');
});

test('сегодня после последнего слота: день пропущен, полоса начинается завтра', () => {
  const days = consultDays(settings(), at('2026-10-27', '17:30'));
  assert.equal(days[0]?.date, '2026-10-28');
  assert.equal(days.length, 7);
});

test('сегодня выходной: полоса начинается с ближайшего рабочего дня', () => {
  assert.equal(consultDays(settings(), at('2026-10-31', '10:00'))[0]?.date, '2026-11-02');
});

test('проверка слота совпадает с полосой: всё, что предлагает полоса, сервер принимает', () => {
  const s = settings();
  const now = at('2026-10-27', '12:10');
  for (const d of consultDays(s, now)) for (const t of d.times) assert.equal(checkConsultSlot(s, d.date, t, now), 'ok', `${d.date} ${t}`);
});

test('проверка слота: вне сетки, выходной, вне горизонта, прошедшее', () => {
  const s = settings();
  const now = at('2026-10-27', '12:10');
  assert.equal(checkConsultSlot(s, '2026-10-28', '09:20', now), 'outside_hours');
  assert.equal(checkConsultSlot(s, '2026-10-31', '10:30', now), 'outside_hours', 'суббота');
  assert.equal(checkConsultSlot(s, '2026-12-01', '10:30', now), 'outside_hours', 'дальше горизонта');
  assert.equal(checkConsultSlot(s, '2026-10-26', '10:30', now), 'outside_hours', 'вчера');
  assert.equal(checkConsultSlot(s, '2026-10-27', '10:30', now), 'slot_in_past');
  assert.equal(checkConsultSlot(s, '2026-10-27', '12:00', now), 'slot_in_past');
  assert.equal(checkConsultSlot(s, 'вчера', '10:30', now), 'outside_hours');
  assert.equal(checkConsultSlot(s, '2026-10-28', '18:00', now), 'outside_hours', 'конец рабочего дня — не слот');
});
