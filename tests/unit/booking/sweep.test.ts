// workdaysAfter (B4b, §3.2): рабочие дни строго после даты и не позже сегодня. Календарь из ядра; пояс процесса
// на результат не влияет (TZ=UTC и TZ=Asia/Almaty дают то же).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../../../packages/core/src';
import { workdaysAfter } from '../../../src/server/domain/booking/sweep';

const cal = (holidays: time.CalendarSettings['holidays'] = []) =>
  time.createWorkCalendar({
    timezone: 'Asia/Almaty',
    workdays: [1, 2, 3, 4, 5],
    workHours: { start: '09:00', end: '18:00' },
    callWindow: { start: '09:00', end: '18:00' },
    holidays,
  });

test('чт 29.10 → пт 30.10 = 1, → пн 02.11 = 2, сб и вс не считаются', () => {
  assert.equal(workdaysAfter(cal(), '2026-10-29', '2026-10-30'), 1);
  assert.equal(workdaysAfter(cal(), '2026-10-29', '2026-10-31'), 1);
  assert.equal(workdaysAfter(cal(), '2026-10-29', '2026-11-02'), 2);
});

test('тот же день и будущее — 0', () => {
  assert.equal(workdaysAfter(cal(), '2026-10-29', '2026-10-29'), 0);
  assert.equal(workdaysAfter(cal(), '2026-10-30', '2026-10-29'), 0);
});

test('праздник в пятницу не считается', () => {
  const c = cal([{ date: '2026-10-30', kind: 'holiday' }]);
  assert.equal(workdaysAfter(c, '2026-10-29', '2026-10-30'), 0);
  assert.equal(workdaysAfter(c, '2026-10-29', '2026-11-02'), 1);
});

test('рабочий перенос на субботу считается', () => {
  const c = cal([{ date: '2026-10-31', kind: 'workday' }]);
  assert.equal(workdaysAfter(c, '2026-10-29', '2026-10-31'), 2);
  assert.equal(workdaysAfter(c, '2026-10-29', '2026-11-02'), 3);
});
