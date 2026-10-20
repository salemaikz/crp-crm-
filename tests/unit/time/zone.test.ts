// Перевод epoch-мс ↔ местное время (P6). Ожидания посчитаны руками, не кодом модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDays,
  addLocalDays,
  assertTimeZone,
  fromLocalTime,
  isoWeekday,
  isValidDay,
  localDayOf,
  parseDay,
  parseHHMM,
  toLocalTime,
  utcOffsetMs,
} from '../../../packages/core/src/time';
import { at } from './_kz';

const ALMATY = 'Asia/Almaty';
const HOUR = 3_600_000;

test('Asia/Almaty: с 2024 года UTC+5 (страж старой tzdata, CONFIG §6.1)', () => {
  for (const t of [Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 26, 12)]) {
    assert.equal(utcOffsetMs(t, ALMATY), 5 * HOUR);
  }
});

test('toLocalTime: части местного времени, день недели ISO, миллисекунды', () => {
  // 2026-10-26 07:30:15.250 UTC = 12:30:15.250 в Алматы, понедельник
  const p = toLocalTime(Date.UTC(2026, 9, 26, 7, 30, 15, 250), ALMATY);
  assert.deepEqual(
    { day: p.day, h: p.hour, m: p.minute, s: p.second, ms: p.millisecond, wd: p.weekday },
    { day: '2026-10-26', h: 12, m: 30, s: 15, ms: 250, wd: 1 },
  );
  assert.equal(p.msOfDay, ((12 * 60 + 30) * 60 + 15) * 1000 + 250);
});

test('местные сутки переходят через полночь по поясу, а не по UTC', () => {
  assert.equal(localDayOf(Date.UTC(2026, 9, 25, 19, 0), ALMATY), '2026-10-26'); // 00:00 в Алматы
  assert.equal(localDayOf(Date.UTC(2026, 9, 25, 18, 59, 59, 999), ALMATY), '2026-10-25'); // 23:59:59.999
  assert.equal(localDayOf(Date.UTC(2026, 11, 31, 19, 0), ALMATY), '2027-01-01'); // переход года
});

test('fromLocalTime ↔ toLocalTime: круг без потерь', () => {
  const t = fromLocalTime('2026-12-31', '23:59', ALMATY);
  assert.equal(t, at('2026-12-31 23:59'));
  const p = toLocalTime(t, ALMATY);
  assert.equal(p.day, '2026-12-31');
  assert.equal(p.hour * 60 + p.minute, 23 * 60 + 59);
});

test('addCalendarDays: те же местные часы, секунды и мс сохраняются', () => {
  const t = at('2026-12-30 17:45:10.123');
  assert.equal(addCalendarDays(t, 3, ALMATY), at('2027-01-02 17:45:10.123'));
  assert.equal(addCalendarDays(t, -30, ALMATY), at('2026-11-30 17:45:10.123'));
});

test('арифметика по датам: конец месяца, високосный год, переход года', () => {
  assert.equal(addLocalDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addLocalDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addLocalDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addLocalDays('2027-01-01', -1), '2026-12-31');
  assert.equal(isoWeekday('2026-10-25'), 7); // воскресенье
  assert.equal(isoWeekday('2026-10-26'), 1); // понедельник
  assert.equal(isoWeekday('2027-01-01'), 5); // пятница
});

test('проверка входных строк', () => {
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('2026-2-3'), false);
  assert.equal(isValidDay(20261026), false);
  assert.equal(isValidDay('2028-02-29'), true);
  assert.throws(() => parseDay('2026-13-01'), RangeError);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 23 * 60 + 59);
  assert.throws(() => parseHHMM('24:00'), RangeError);
  assert.throws(() => parseHHMM('9:00'), RangeError);
  assert.throws(() => assertTimeZone('Mars/Olympus'), RangeError);
  assert.throws(() => assertTimeZone(''), RangeError);
  assert.doesNotThrow(() => assertTimeZone('UTC'));
});

// Переход на летнее время в РК не используется, но функции должны быть верны для любого пояса настроек.
test('пояс с летним временем: «дыра» сдвигается вперёд, повтор часа — первое вхождение', () => {
  const NY = 'America/New_York';
  // 2026-03-08 в 02:00 EST часы идут на 03:00 EDT: 02:30 не существует → 03:30 EDT = 07:30 UTC
  assert.equal(fromLocalTime('2026-03-08', '02:30', NY), Date.UTC(2026, 2, 8, 7, 30));
  // 2026-11-01 в 02:00 EDT часы идут на 01:00 EST: 01:30 бывает дважды, берём первое (EDT) = 05:30 UTC
  assert.equal(fromLocalTime('2026-11-01', '01:30', NY), Date.UTC(2026, 10, 1, 5, 30));
  // обычное время рядом
  assert.equal(fromLocalTime('2026-03-08', '03:00', NY), Date.UTC(2026, 2, 8, 7, 0));
  assert.equal(fromLocalTime('2026-03-07', '12:00', NY), Date.UTC(2026, 2, 7, 17, 0)); // EST, -5
  assert.equal(fromLocalTime('2026-03-09', '12:00', NY), Date.UTC(2026, 2, 9, 16, 0)); // EDT, -4
});

test('addCalendarDays в поясе с DST: местные часы те же, а не +24 ч', () => {
  const NY = 'America/New_York';
  const sat = Date.UTC(2026, 2, 7, 17, 0); // сб 12:00 EST
  const mon = addCalendarDays(sat, 2, NY); // пн 12:00 EDT
  assert.equal(mon, Date.UTC(2026, 2, 9, 16, 0));
  assert.notEqual(mon, sat + 48 * HOUR);
});
