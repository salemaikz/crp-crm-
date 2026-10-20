// Сборка отчётов из строк репозитория (R3a): корзины, итоги, воронка, выручка, явка, причины. Только синтетика.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttendanceReport } from '../../../src/server/domain/reports/attendance';
import { funnelBySourceRows, funnelOf, funnelRates } from '../../../src/server/domain/reports/funnel';
import { buildOperatorsReport, emptyCounts, type UserDayCell } from '../../../src/server/domain/reports/operators';
import { buildReasonsReport } from '../../../src/server/domain/reports/reasons';
import { buildRevenueReport } from '../../../src/server/domain/reports/revenue';
import type { ResolvedPeriod } from '../../../src/server/domain/reports/reportTypes';

const period: ResolvedPeriod = { from: '2026-10-26', to: '2026-11-01', fromMs: 0, toMs: 1, timeZone: 'Asia/Almaty', days: 7 };
const cell = (userId: string, day: string, over: Partial<ReturnType<typeof emptyCounts>>): UserDayCell => ({ userId, day, counts: { ...emptyCounts(), ...over } });
const names = new Map([['a', 'Оператор А'], ['b', 'Оператор Б']]);

test('операторы: часы суммируются по дням, звонков в час — по сумме; ниже нормы — отметка', () => {
  const cells = [
    cell('a', '2026-10-26', { outcomes: 20, workedHours: 2 }),
    cell('a', '2026-10-27', { outcomes: 5, workedHours: 1 }),
    cell('b', '2026-10-27', { outcomes: 40, workedHours: 2 }),
  ];
  const r = buildOperatorsReport({ period, grouping: 'total', target: 10, cells, names, participants: ['a', 'b', 'c'] });
  const a = r.rows.find((x) => x.userId === 'a')!;
  assert.equal(a.outcomes, 25);
  assert.equal(a.workedHours, 3);
  assert.equal(a.callsPerHour, 8.3);
  assert.equal(a.belowTarget, true);
  assert.equal(r.rows.find((x) => x.userId === 'b')!.belowTarget, false);
  // участник раздачи без данных виден нулевой строкой, без «ниже нормы» (часов нет)
  const c = r.rows.find((x) => x.userId === 'c')!;
  assert.equal(c.outcomes, 0);
  assert.equal(c.callsPerHour, null);
  assert.equal(c.belowTarget, false);
  assert.equal(r.totals.outcomes, 65);
  assert.equal(r.totals.callsPerHour, 13);
});

test('операторы: корзины день и неделя; нулевые участники только в общей корзине', () => {
  const cells = [cell('a', '2026-10-26', { outcomes: 4, workedHours: 1 }), cell('a', '2026-11-01', { outcomes: 6, workedHours: 1 }), cell('a', '2026-11-02', { outcomes: 1, workedHours: 1 })];
  const byDay = buildOperatorsReport({ period, grouping: 'day', target: null, cells, names, participants: ['a', 'b'] });
  assert.deepEqual(byDay.rows.map((x) => x.bucket), ['2026-10-26', '2026-11-01', '2026-11-02']);
  const byWeek = buildOperatorsReport({ period, grouping: 'week', target: null, cells, names, participants: ['a', 'b'] });
  assert.deepEqual(byWeek.rows.map((x) => [x.bucket, x.outcomes]), [['2026-10-26', 10], ['2026-11-02', 1]]);
  assert.ok(byWeek.rows.every((x) => x.userId === 'a'));
});

test('воронка: конверсия к предыдущему шагу, первый шаг без доли, нули не делят', () => {
  const c = funnelOf({ ...emptyCounts(), issued: 200, connects: 50, lpr: 20, groups: 6, consults: 4, attended: 5, purchases: 2 });
  assert.deepEqual(c, { issued: 200, connected: 50, lpr: 20, booked: 10, attended: 5, purchased: 2 });
  const r = funnelRates(c);
  assert.equal(r.issued, null);
  assert.equal(r.connected, 25);
  assert.equal(r.lpr, 40);
  assert.equal(r.booked, 50);
  assert.equal(r.purchased, 40);
  assert.equal(funnelRates({ issued: 0, connected: 0, lpr: 0, booked: 0, attended: 0, purchased: 0 }).connected, null);
});

test('воронка по источникам: строки по ключу, итог — сумма', () => {
  const r = funnelBySourceRows([
    { src: 'new_base', step: 'issued', n: 30 },
    { src: 'new_base', step: 'connected', n: 9 },
    { src: '', step: 'issued', n: 5 },
    { src: 'manual', step: 'issued', n: 12 },
  ]);
  assert.deepEqual(r.rows.map((x) => x.key), ['new_base', 'manual', '']);
  assert.equal(r.total.counts.issued, 47);
  assert.equal(r.rows[0]!.rates.connected, 30);
});

test('выручка: первые и повторные, сортировка по сумме, итог', () => {
  const r = buildRevenueReport(period, [
    { serviceTypeKey: 'consult', purchases: 3, sumKzt: '150000', firstPurchases: 2, firstSumKzt: '100000' },
    { serviceTypeKey: 'master', purchases: 1, sumKzt: '400000', firstPurchases: 1, firstSumKzt: '400000' },
  ]);
  assert.deepEqual(r.rows.map((x) => x.serviceTypeKey), ['master', 'consult']);
  const consult = r.rows[1]!;
  assert.equal(consult.repeatPurchases, 1);
  assert.equal(consult.repeatSumKzt, 50000);
  assert.deepEqual(r.total, { purchases: 4, sumKzt: 550000, firstPurchases: 3, firstSumKzt: 500000, repeatPurchases: 1, repeatSumKzt: 50000 });
});

test('явка: доля = пришли / (пришли + не пришли); покупки в итоге — различные сделки', () => {
  const r = buildAttendanceReport({
    period,
    by: 'consultant',
    rows: [
      { grp: 'u1', booked: 10, attended: 6, noShow: 2, unmarked: 1, cancelled: 3 },
      { grp: '', booked: 2, attended: 0, noShow: 0, unmarked: 2, cancelled: 0 },
    ],
    purchases: [
      { grp: 'u1', dealId: 'd1' },
      { grp: '', dealId: 'd1' }, // одна сделка в двух группах
      { grp: 'u1', dealId: 'd2' },
    ],
    names: new Map([['u1', 'Консультант 1']]),
  });
  const u1 = r.rows.find((x) => x.key === 'u1')!;
  assert.equal(u1.rate, 75);
  assert.equal(u1.name, 'Консультант 1');
  assert.equal(u1.purchases, 2);
  assert.equal(r.rows.find((x) => x.key === '')!.rate, null);
  assert.equal(r.total.purchases, 2);
  assert.equal(r.total.booked, 12);
  assert.equal(r.total.rate, 75);
});

test('причины: доля внутри группы, порядок групп и убывание', () => {
  const r = buildReasonsReport(period, [
    { grp: 'deal_lost', reasonCode: 'price', n: 1 },
    { grp: 'not_target', reasonCode: 'ip', n: 3 },
    { grp: 'not_interested', reasonCode: 'busy', n: 1 },
    { grp: 'not_interested', reasonCode: 'later', n: 3 },
  ]);
  assert.deepEqual(r.rows.map((x) => `${x.group}:${x.reasonCode}`), ['not_interested:later', 'not_interested:busy', 'not_target:ip', 'deal_lost:price']);
  assert.equal(r.rows[0]!.share, 75);
  assert.equal(r.rows[2]!.share, 100);
});
