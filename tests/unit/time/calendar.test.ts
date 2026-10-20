// Рабочий календарь (P6, PLAN День 1): 26.10.2026 нерабочий; пятница 17:00 + 2 ч → ближайший рабочий день;
// праздник пропускается; граница окна 18:00; переход года; независимость от TZ процесса.
// Ожидания взяты из PROCESS §3.4 и из календаря Минтруда, а не вычислены кодом модуля.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkCalendar } from '../../../packages/core/src/time';
import type { CalendarHoliday, CalendarSettings } from '../../../packages/core/src/time';
import type { WorkCalendar as SpecWorkCalendar } from '../../../packages/core/src/calling/spec/types';
import { TEST_CALENDAR } from '../../../packages/core/src/calling/spec/vectors';
import { at, kzSettings, show } from './_kz';

const HOUR = 3_600_000;
const MIN = 60_000;
const kz = createWorkCalendar(kzSettings());

function same(actual: number, expected: number, what: string): void {
  assert.equal(actual, expected, `${what}: ожидали ${show(expected)}, получили ${show(actual)}`);
}

/** Календарь с ЗАМЕНОЙ списка праздников (слой kz не подмешивается) — для синтетических сценариев. */
function custom(holidays: CalendarHoliday[], patch: Partial<CalendarSettings> = {}) {
  return createWorkCalendar({ ...kzSettings(), holidays, ...patch });
}

// ---------- Контракт ядра ----------

test('календарь выполняет контракт WorkCalendar из calling/spec (проверка типов)', () => {
  const spec: SpecWorkCalendar = kz;
  assert.equal(spec.callWindowStart, '09:00');
});

// ---------- Рабочие и нерабочие дни ----------

test('26.10.2026 нерабочий: перенос за День Республики (25.10 — воскресенье)', () => {
  assert.equal(kz.isWorkday('2026-10-26'), false);
  assert.equal(kz.isWorkday('2026-10-25'), false);
  assert.equal(kz.isWorkday('2026-10-23'), true);
  assert.equal(kz.isWorkday('2026-10-27'), true);
  const info = kz.dayInfo('2026-10-26');
  assert.equal(info.workday, false);
  assert.equal(info.reason, 'holiday');
  assert.match(info.note ?? '', /25\.10/);
  assert.equal(kz.isInCallWindow(at('2026-10-26 12:00')), false);
  assert.equal(kz.isWorkingMoment(at('2026-10-26 12:00')), false);
});

test('dayInfo: рабочий, выходные недели, праздник', () => {
  assert.deepEqual(kz.dayInfo('2026-10-20'), { day: '2026-10-20', workday: true, reason: 'workday' });
  assert.deepEqual(kz.dayInfo('2026-10-24'), { day: '2026-10-24', workday: false, reason: 'weekend' });
  assert.equal(kz.dayInfo('2026-07-06').reason, 'holiday');
});

test('даты из календаря Минтруда на 2026 год: переносы Наурыза, 9 и 11 мая, Курбан айт, 17 декабря', () => {
  for (const d of ['2026-03-09', '2026-03-23', '2026-03-24', '2026-03-25', '2026-05-01', '2026-05-07', '2026-05-11', '2026-05-27', '2026-07-06', '2026-12-16']) {
    assert.equal(kz.isWorkday(d), false, `${d} должен быть нерабочим`);
  }
  for (const d of ['2026-05-08', '2026-05-28', '2026-05-29', '2026-08-31', '2026-12-17', '2026-12-30', '2026-12-31']) {
    assert.equal(kz.isWorkday(d), true, `${d} должен быть рабочим`);
  }
});

test('2027: праздники по закону нерабочие, Курбан айт — воскресенье 16.05, переноса на 17.05 нет', () => {
  for (const d of ['2027-01-01', '2027-01-07', '2027-03-08', '2027-03-15', '2027-03-22', '2027-03-23', '2027-05-07', '2027-07-06', '2027-10-25', '2027-12-16']) {
    assert.equal(kz.isWorkday(d), false, `${d} должен быть нерабочим`);
  }
  assert.equal(kz.isWorkday('2027-05-17'), true);
  assert.equal(kz.isWorkday('2027-08-30'), true); // День Конституции теперь 15 марта
});

test('выходной недели можно сделать рабочим переносом, рабочий — выходным; клиентская строка перекрывает слой kz', () => {
  const c = createWorkCalendar(
    kzSettings([
      { date: '2026-11-07', kind: 'workday', note: 'отработка' }, // суббота
      { date: '2026-11-11', kind: 'holiday', note: 'корпоратив' }, // среда
      { date: '2026-10-26', kind: 'workday', note: 'клиент работает' }, // слой kz делал его выходным
    ]),
  );
  assert.deepEqual(c.dayInfo('2026-11-07'), { day: '2026-11-07', workday: true, reason: 'transferred_workday', note: 'отработка' });
  assert.equal(c.isWorkday('2026-11-11'), false);
  assert.equal(c.isWorkday('2026-10-26'), true);
  assert.equal(c.dayInfo('2026-10-26').reason, 'workday');
  assert.equal(c.isInCallWindow(at('2026-11-07 11:00')), true);
  assert.equal(c.isInCallWindow(at('2026-11-08 11:00')), false);
  // праздники слоя kz, не затронутые клиентом, остаются
  assert.equal(c.isWorkday('2026-07-06'), false);
});

test('шестидневная неделя: суббота рабочая, воскресенье нет', () => {
  const c = custom([], { workdays: [1, 2, 3, 4, 5, 6] });
  assert.equal(c.isWorkday('2026-10-24'), true);
  assert.equal(c.isWorkday('2026-10-25'), false);
  assert.equal(c.nextWorkday('2026-10-24'), '2026-10-26');
});

test('nextWorkday, workdayOnOrAfter, addWorkdays', () => {
  assert.equal(kz.nextWorkday('2026-10-23'), '2026-10-27'); // пт → вт (пн 26.10 выходной)
  assert.equal(kz.nextWorkday('2026-10-20'), '2026-10-21');
  assert.equal(kz.workdayOnOrAfter('2026-10-20'), '2026-10-20');
  assert.equal(kz.workdayOnOrAfter('2026-10-24'), '2026-10-27');
  assert.equal(kz.addWorkdays('2026-10-23', 1), '2026-10-27');
  assert.equal(kz.addWorkdays('2026-10-23', 3), '2026-10-29');
  assert.throws(() => kz.addWorkdays('2026-10-23', 0), RangeError);
  assert.throws(() => kz.addWorkdays('2026-10-23', 1.5), RangeError);
});

// ---------- Окна: полуоткрытые ----------

test('граница окна 18:00: 09:00 входит, 18:00 уже вне окна (до миллисекунды)', () => {
  const day = '2026-10-20';
  assert.equal(kz.isInCallWindow(at(`${day} 08:59:59.999`)), false);
  assert.equal(kz.isInCallWindow(at(`${day} 09:00`)), true);
  assert.equal(kz.isInCallWindow(at(`${day} 17:59:59.999`)), true);
  assert.equal(kz.isInCallWindow(at(`${day} 18:00`)), false);
  assert.equal(kz.isWorkingMoment(at(`${day} 17:59:59.999`)), true);
  assert.equal(kz.isWorkingMoment(at(`${day} 18:00`)), false);
  assert.equal(kz.isWorkingMoment(at(`${day} 09:00`)), true);
});

test('окно звонков и рабочие часы настраиваются независимо', () => {
  const c = custom([], { callWindow: { start: '10:00', end: '16:00' } });
  const t = at('2026-10-20 17:00');
  assert.equal(c.isWorkingMoment(t), true);
  assert.equal(c.isInCallWindow(t), false);
  assert.equal(c.callWindowStart, '10:00');
  same(c.nextCallMoment(at('2026-10-20 09:30')), at('2026-10-20 10:00'), 'до окна звонков');
  same(c.nextCallMoment(at('2026-10-20 16:00')), at('2026-10-21 10:00'), 'ровно конец окна звонков');
});

test('nextWorkingMoment: сам момент, начало окна, выходные и праздник пропускаются', () => {
  same(kz.nextWorkingMoment(at('2026-10-20 12:00')), at('2026-10-20 12:00'), 'внутри окна');
  same(kz.nextWorkingMoment(at('2026-10-20 07:00')), at('2026-10-20 09:00'), 'до открытия');
  same(kz.nextWorkingMoment(at('2026-10-20 18:00')), at('2026-10-21 09:00'), 'ровно конец окна');
  same(kz.nextWorkingMoment(at('2026-10-23 18:00')), at('2026-10-27 09:00'), 'пятница вечером → вторник (пн 26.10 — перенос)');
  same(kz.nextWorkingMoment(at('2026-10-24 12:00')), at('2026-10-27 09:00'), 'суббота');
});

// ---------- Правило повторов PROCESS §3.4: +2 ч, иначе ближайшие 10:00 рабочего дня ----------

const retry = (from: string) => kz.addInWindowOrNextAt(at(from), 2 * HOUR, '10:00');

test('PROCESS 3.4: примеры правила +2 ч / следующий рабочий 10:00', () => {
  same(retry('2026-10-20 14:20'), at('2026-10-20 16:20'), 'вт 14:20 → вт 16:20');
  same(retry('2026-10-20 16:30'), at('2026-10-21 10:00'), 'вт 16:30 (18:30 вне окна) → ср 10:00');
  same(retry('2026-10-16 17:00'), at('2026-10-19 10:00'), 'пт 17:00 → пн 10:00');
  same(retry('2026-10-23 17:00'), at('2026-10-27 10:00'), 'пт 23.10 17:00 → вт 27.10 10:00 (25.10 вс, 26.10 перенос)');
});

test('PROCESS 3.4, уточнения: полуоткрытое окно, выходной, ранний недозвон', () => {
  same(retry('2026-10-20 16:00'), at('2026-10-21 10:00'), 'вт 16:00 (+2 ч = 18:00, вне окна) → ср 10:00');
  same(kz.addInWindowOrNextAt(at('2026-10-20 15:59:59.999'), 2 * HOUR, '10:00'), at('2026-10-20 17:59:59.999'), '17:59:59.999 ещё в окне');
  same(retry('2026-10-24 12:00'), at('2026-10-27 10:00'), 'сб 24.10 12:00 → вт 27.10 10:00');
  same(retry('2026-10-20 06:30'), at('2026-10-20 10:00'), 'вт 06:30 (08:30 до окна) → вт 10:00');
  same(retry('2026-10-20 08:30'), at('2026-10-20 10:30'), 'вт 08:30 → 10:30 в окне');
  same(retry('2026-10-20 22:00'), at('2026-10-21 10:00'), 'вт 22:00 → ср 10:00');
});

test('праздник пропускается: День Столицы, Курбан айт, Наурыз с переносами', () => {
  same(retry('2026-07-03 17:00'), at('2026-07-07 10:00'), 'пт 03.07 → вт 07.07 (пн 06.07 — День Столицы)');
  same(retry('2026-05-26 17:00'), at('2026-05-28 10:00'), 'вт 26.05 → чт 28.05 (ср 27.05 — Курбан айт)');
  same(retry('2026-03-20 17:00'), at('2026-03-26 10:00'), 'пт 20.03 → чт 26.03 (пн 23, вт 24 и ср 25 нерабочие)');
});

test('addInWindowOrNextAt: окно рабочих часов вместо звонков', () => {
  const c = custom([], { callWindow: { start: '10:00', end: '16:00' } });
  same(c.addInWindowOrNextAt(at('2026-10-20 15:00'), 2 * HOUR, '09:30', 'work'), at('2026-10-20 17:00'), 'work: 17:00 внутри рабочих часов');
  same(c.addInWindowOrNextAt(at('2026-10-20 15:00'), 2 * HOUR, '10:00', 'call'), at('2026-10-21 10:00'), 'call: 17:00 вне окна звонков');
});

// ---------- N-е рабочее утро в HH:MM ----------

test('nextWorkdayAt / nthWorkdayAt: n-й рабочий день строго после местных суток', () => {
  same(kz.nextWorkdayAt(at('2026-10-23 15:00'), '10:00'), at('2026-10-27 10:00'), 'следующий после пт 23.10');
  same(kz.nextWorkdayAt(at('2026-10-20 06:30'), '10:00'), at('2026-10-21 10:00'), 'ранний недозвон: «следующий», а не «ближайшие 10:00»');
  same(kz.nextWorkdayAt(at('2026-10-20 08:30'), '10:00'), at('2026-10-21 10:00'), 'вт 08:30 → ср 10:00');
  same(kz.nthWorkdayAt(at('2026-10-23 15:00'), 1, '10:00'), at('2026-10-27 10:00'), 'n=1');
  same(kz.nthWorkdayAt(at('2026-10-23 15:00'), 3, '09:30'), at('2026-10-29 09:30'), 'n=3 → чт 29.10');
  assert.throws(() => kz.nthWorkdayAt(at('2026-10-23 15:00'), 0, '10:00'), RangeError);
  assert.throws(() => kz.nthWorkdayAt(at('2026-10-23 15:00'), 1, '25:00'), RangeError);
});

test('nextWorkdayTimeAfter: строго позже `after`, ровно совпавшее время не считается', () => {
  same(kz.nextWorkdayTimeAfter(at('2026-10-20 10:00'), '10:00'), at('2026-10-21 10:00'), 'совпало — берём следующий день');
  same(kz.nextWorkdayTimeAfter(at('2026-10-20 09:59:59.999'), '10:00'), at('2026-10-20 10:00'), 'за миллисекунду до');
  same(kz.nextWorkdayTimeAfter(at('2026-10-23 19:00'), '10:00'), at('2026-10-27 10:00'), 'через выходные и перенос');
});

test('addDays: календарные сутки с тем же местным временем, рабочий день не требуется', () => {
  same(kz.addDays(at('2026-10-23 17:30'), 1), at('2026-10-24 17:30'), '+1 сутки в субботу');
  same(kz.addDays(at('2026-10-23 17:30'), 90), at('2027-01-21 17:30'), '+90 суток через переход года');
  same(kz.addDays(at('2026-10-23 17:30'), -3), at('2026-10-20 17:30'), 'назад');
});

// ---------- Переход года ----------

test('переход года: сутки, сдвиги и рабочие часы через 31 декабря (праздники и перенос заданы явно)', () => {
  // как в официальном календаре: 1–2 января праздник, пн 4 января — перенос за 2 января
  const c = custom([
    { date: '2027-01-01', kind: 'holiday' },
    { date: '2027-01-02', kind: 'holiday' },
    { date: '2027-01-04', kind: 'holiday', note: 'перенос с 02.01' },
  ]);
  assert.equal(c.localDay(at('2026-12-31 23:59:59.999')), '2026-12-31');
  assert.equal(c.localDay(at('2027-01-01 00:00')), '2027-01-01');
  assert.equal(c.isWorkday('2026-12-31'), true);
  assert.equal(c.nextWorkday('2026-12-31'), '2027-01-05');
  same(c.addInWindowOrNextAt(at('2026-12-31 17:00'), 2 * HOUR, '10:00'), at('2027-01-05 10:00'), 'чт 31.12 17:00 → вт 05.01 10:00');
  same(c.nextWorkdayAt(at('2026-12-30 12:00'), '10:00'), at('2026-12-31 10:00'), 'ср 30.12 → чт 31.12');
  same(c.addWorkingHours(at('2026-12-31 17:00'), 2), at('2027-01-05 10:00'), '1 ч до конца года + 1 ч в январе');
  same(c.addDays(at('2026-12-31 17:00'), 1), at('2027-01-01 17:00'), 'сутки через полночь года');
});

test('официальный календарь 2026: 30 и 31 декабря рабочие, 1 января 2027 нерабочий', () => {
  assert.equal(kz.isWorkday('2026-12-31'), true);
  assert.equal(kz.isWorkday('2027-01-01'), false);
  same(kz.nextWorkdayAt(at('2026-12-30 12:00'), '10:00'), at('2026-12-31 10:00'), 'ср 30.12 → чт 31.12');
});

// ---------- Рабочие часы ----------

test('addWorkingHours: считаются только рабочие часы, выходные и праздник пропускаются', () => {
  same(kz.addWorkingHours(at('2026-10-19 09:00'), 9), at('2026-10-19 18:00'), 'пн 09:00 + 9 ч = конец окна 18:00');
  same(kz.addWorkingHours(at('2026-10-19 10:00'), 8), at('2026-10-19 18:00'), 'пн 10:00 + 8 ч');
  same(kz.addWorkingHours(at('2026-10-19 10:00'), 8.5), at('2026-10-20 09:30'), 'пн 10:00 + 8,5 ч → вт 09:30');
  same(kz.addWorkingHours(at('2026-10-16 17:00'), 2), at('2026-10-19 10:00'), 'пт 17:00 + 2 ч → пн 10:00');
  same(kz.addWorkingHours(at('2026-10-23 17:00'), 2), at('2026-10-27 10:00'), 'пт 23.10 17:00 + 2 ч → вт 27.10 10:00 (пн 26.10 пропущен)');
  same(kz.addWorkingHours(at('2026-10-24 12:00'), 1), at('2026-10-27 10:00'), 'старт в субботу: отсчёт с открытия вт 09:00');
  same(kz.addWorkingHours(at('2026-10-20 07:00'), 1), at('2026-10-20 10:00'), 'старт до открытия');
  same(kz.addWorkingHours(at('2026-10-19 09:00'), 45), at('2026-10-23 18:00'), 'пять полных дней: пт 18:00');
  same(kz.addWorkingHours(at('2026-10-19 09:00'), 46), at('2026-10-27 10:00'), '46 ч: пн 26.10 перенос, вт 10:00');
  same(kz.addWorkingHours(at('2026-10-20 15:00'), 0), at('2026-10-20 15:00'), '0 ч — тот же момент');
  same(kz.addWorkingHours(at('2026-10-24 12:00'), 0), at('2026-10-24 12:00'), '0 ч в выходной — тот же момент');
  same(kz.addWorkingMs(at('2026-10-20 17:59'), 30 * MIN), at('2026-10-21 09:29'), '1 мин в день, 29 мин на следующий');
  assert.throws(() => kz.addWorkingMs(at('2026-10-20 15:00'), -1), RangeError);
  assert.throws(() => kz.addWorkingMs(at('2026-10-20 15:00'), Number.NaN), RangeError);
});

test('workingMsBetween обратна addWorkingMs (детерминированная проверка на 300 случаях)', () => {
  assert.equal(kz.workingMsBetween(at('2026-10-23 17:00'), at('2026-10-27 10:00')), 2 * HOUR);
  assert.equal(kz.workingMsBetween(at('2026-10-24 00:00'), at('2026-10-26 23:00')), 0);
  assert.equal(kz.workingMsBetween(at('2026-10-20 12:00'), at('2026-10-20 12:00')), 0);
  assert.throws(() => kz.workingMsBetween(at('2026-10-21 12:00'), at('2026-10-20 12:00')), RangeError);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const start = at('2026-10-01 00:00');
  for (let i = 0; i < 300; i++) {
    const from = start + Math.floor(rnd() * 90 * 24 * HOUR);
    const ms = Math.floor(rnd() * 60 * HOUR) + 1;
    const to = kz.addWorkingMs(from, ms);
    assert.equal(kz.workingMsBetween(from, to), ms, `from ${show(from)} +${ms} мс → ${show(to)}`);
    assert.ok(to > from);
  }
});

// ---------- Сверка с тестовым календарём K1d ----------

test('совпадает с TEST_CALENDAR (calling/spec) на шаге 30 минут с 19.10 по 14.12.2026', () => {
  // до 16.12 (День Независимости) в слое kz нет праздников, кроме 26.10, как и в TEST_CALENDAR
  const end = at('2026-12-14 23:59');
  const spec: SpecWorkCalendar = TEST_CALENDAR;
  for (let t = at('2026-10-19 00:00'); t <= end; t += 30 * MIN) {
    assert.equal(kz.localDay(t), spec.localDay(t), `localDay ${show(t)}`);
    assert.equal(kz.isInCallWindow(t), spec.isInCallWindow(t), `isInCallWindow ${show(t)}`);
    assert.equal(kz.isWorkday(kz.localDay(t)), spec.isWorkday(spec.localDay(t)), `isWorkday ${show(t)}`);
    assert.equal(kz.nextWorkdayAt(t, '10:00'), spec.nextWorkdayAt(t, '10:00'), `nextWorkdayAt ${show(t)}`);
    assert.equal(kz.nextWorkdayTimeAfter(t, '10:00'), spec.nextWorkdayTimeAfter(t, '10:00'), `nextWorkdayTimeAfter ${show(t)}`);
    assert.equal(kz.addDays(t, 3), spec.addDays(t, 3), `addDays ${show(t)}`);
  }
});

// ---------- Независимость от TZ процесса ----------

function battery(): unknown {
  const times = [at('2026-10-20 14:20'), at('2026-10-23 17:00'), at('2026-12-31 23:59:59.999'), at('2026-10-20 18:00'), at('2026-10-26 12:00')];
  return times.map((t) => [
    kz.localDay(t),
    kz.isInCallWindow(t),
    kz.isWorkingMoment(t),
    kz.nextWorkingMoment(t),
    kz.nextWorkdayAt(t, '10:00'),
    kz.addInWindowOrNextAt(t, 2 * HOUR, '10:00'),
    kz.addWorkingHours(t, 3),
    kz.addDays(t, 2),
  ]);
}

test('результат не зависит от TZ процесса (проверка на 5 поясах, включая +14 и −11)', () => {
  const saved = process.env.TZ;
  // смещение `Date#getTimezoneOffset` (минуты, знак обратный) нужно, чтобы убедиться, что TZ реально сменился
  const zones: Array<[string, number]> = [
    ['UTC', 0],
    ['Asia/Almaty', -300],
    ['America/New_York', 300],
    ['Pacific/Kiritimati', -840],
    ['Pacific/Pago_Pago', 660],
  ];
  try {
    const baseline = JSON.stringify(battery());
    for (const [zone, offset] of zones) {
      process.env.TZ = zone;
      assert.equal(new Date(2026, 0, 1, 12).getTimezoneOffset(), offset, `TZ=${zone} не применился`);
      assert.equal(JSON.stringify(battery()), baseline, `результат изменился при TZ=${zone}`);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('календарь в другом поясе: окна считаются по местному времени пояса настроек', () => {
  const utc = createWorkCalendar({ ...kzSettings(), timezone: 'UTC' });
  assert.equal(utc.isInCallWindow(Date.UTC(2026, 9, 20, 9, 0)), true);
  assert.equal(utc.isInCallWindow(Date.UTC(2026, 9, 20, 18, 0)), false);
  assert.equal(utc.localDay(Date.UTC(2026, 9, 20, 23, 59)), '2026-10-20');
  const ny = createWorkCalendar({ ...kzSettings(), timezone: 'America/New_York' });
  assert.equal(ny.isInCallWindow(Date.UTC(2026, 9, 20, 13, 0)), true); // 09:00 EDT
  assert.equal(ny.isInCallWindow(Date.UTC(2026, 9, 20, 12, 59)), false);
});

// ---------- Ошибки настроек ----------

test('плохие настройки не принимаются молча', () => {
  const bad = (patch: Partial<CalendarSettings>) => () => createWorkCalendar({ ...kzSettings(), ...patch });
  assert.throws(bad({ timezone: 'Mars/Olympus' }), RangeError);
  assert.throws(bad({ workdays: [] }), RangeError);
  assert.throws(bad({ workdays: [0] }), RangeError);
  assert.throws(bad({ workdays: [1, 8] }), RangeError);
  assert.throws(bad({ workHours: { start: '18:00', end: '09:00' } }), RangeError);
  assert.throws(bad({ callWindow: { start: '09:00', end: '09:00' } }), RangeError);
  assert.throws(bad({ callWindow: { start: '9:00', end: '18:00' } }), RangeError);
  assert.throws(bad({ holidays: [{ date: '2026-02-30', kind: 'holiday' }] }), RangeError);
  assert.throws(bad({ holidays: [{ date: '2026-02-20', kind: 'weekend' as 'holiday' }] }), RangeError);
  assert.throws(() => kz.isWorkday('26.10.2026'), RangeError);
});

test('нет рабочих дней в горизонте — ошибка, а не бесконечный цикл', () => {
  const mondays: CalendarHoliday[] = [];
  for (let d = Date.UTC(2026, 0, 5); d < Date.UTC(2038, 0, 1); d += 7 * 86_400_000) {
    mondays.push({ date: new Date(d).toISOString().slice(0, 10), kind: 'holiday' });
  }
  const c = createWorkCalendar({ ...kzSettings(), workdays: [1], holidays: mondays });
  assert.throws(() => c.nextWorkday('2026-10-20'), RangeError);
  assert.throws(() => c.nextWorkdayTimeAfter(at('2026-10-20 12:00'), '10:00'), RangeError);
});
