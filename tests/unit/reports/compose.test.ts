// Правила подсчёта сводки РОП (PROCESS §10.1): статус, звонков в час и мягкая норма, сборка строк оператора.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOperatorRows, callsPerHour, isBelowTarget, operatorStatus, roomToday, type OperatorInputs } from '../../../src/server/domain/reports/compose';
import { parseReportsSlice } from '../../../src/server/domain/reports/settings';

const TODAY = '2026-10-28';
const staff = (userId: string, o: { pausedOn?: string; absentUntil?: string | null } = {}) => ({
  userId,
  name: `Оператор ${userId}`,
  inDistribution: true,
  pausedOn: o.pausedOn ?? '',
  absentUntil: o.absentUntil ?? null,
});

test('статус: отсутствие сильнее паузы, пауза только в свой день', () => {
  assert.equal(operatorStatus({ pausedOn: '', absentUntil: null }, TODAY), 'working');
  assert.equal(operatorStatus({ pausedOn: TODAY, absentUntil: null }, TODAY), 'paused');
  assert.equal(operatorStatus({ pausedOn: '2026-10-27', absentUntil: null }, TODAY), 'working');
  assert.equal(operatorStatus({ pausedOn: TODAY, absentUntil: '2026-10-30' }, TODAY), 'absent');
});

test('звонков в час: итоги / часы, один знак; без часов — null', () => {
  assert.equal(callsPerHour(0, 0), null);
  assert.equal(callsPerHour(25, 2), 12.5);
  assert.equal(callsPerHour(10, 3), 3.3);
});

test('норма — мягкая отметка: только при заданной норме и наличии часов', () => {
  assert.equal(isBelowTarget(9.9, 10), true);
  assert.equal(isBelowTarget(10, 10), false);
  assert.equal(isBelowTarget(3, null), false);
  assert.equal(isBelowTarget(null, 10), false);
});

const base = (over: Partial<OperatorInputs> = {}): OperatorInputs => ({
  staff: [staff('a'), staff('b', { pausedOn: TODAY }), staff('c', { absentUntil: '2026-10-29' })],
  today: TODAY,
  cap: 40,
  capIncludes: ['auto', 'manual', 'return'],
  target: 10,
  issued: [],
  calls: [],
  bookings: [],
  skips: [],
  overdue: [],
  devices: [],
  ...over,
});

test('строки оператора: показатели по id, пустые — нули, порядок как у сотрудников', () => {
  const rows = buildOperatorRows(
    base({
      issued: [
        { toUserId: 'a', kind: 'auto', n: 30 },
        { toUserId: 'a', kind: 'manual', n: 5 },
        { toUserId: 'a', kind: 'inbound', n: 7 }, // вне capIncludes
        { toUserId: 'a', kind: 'merge', n: 9 }, // не вид лимита
      ],
      calls: [{ userId: 'a', outcomes: 20, connects: 8, lpr: 3, hours: 4 }],
      bookings: [{ userId: 'a', groups: 2, consults: 1 }],
      skips: [{ userId: 'a', n: 4 }],
      overdue: [{ userId: 'a', n: 2 }],
      devices: [{ userId: 'a', pending: 5, lastSeenAt: 1000, lastFlushAt: 900 }],
    }),
  );
  assert.deepEqual(rows.map((r) => [r.userId, r.status]), [['a', 'working'], ['b', 'paused'], ['c', 'absent']]);
  const a = rows[0]!;
  assert.equal(a.issued, 35);
  assert.equal(a.cap, 40);
  assert.deepEqual([a.outcomes, a.connects, a.lpr, a.groups, a.consults, a.skips, a.overdue], [20, 8, 3, 2, 1, 4, 2]);
  assert.equal(a.callsPerHour, 5);
  assert.equal(a.belowTarget, true);
  assert.deepEqual([a.unsent, a.lastSeenAt, a.lastFlushAt], [5, 1000, 900]);
  const b = rows[1]!;
  assert.deepEqual([b.issued, b.outcomes, b.callsPerHour, b.belowTarget, b.unsent, b.lastSeenAt], [0, 0, null, false, 0, null]);
  assert.equal(rows[2]!.absentUntil, '2026-10-29');
});

test('запас лимита считают только работающие', () => {
  const rows = buildOperatorRows(base({ issued: [{ toUserId: 'a', kind: 'auto', n: 30 }, { toUserId: 'b', kind: 'auto', n: 10 }] }));
  // a: 10, b на паузе и c отсутствует не считаются
  assert.equal(roomToday(rows), 10);
});

test('настройки: порог просрочки и норма из документа, по умолчанию 60 и null', () => {
  assert.deepEqual(parseReportsSlice({ tasks: { overdueAlertMinutes: 30 }, reports: { callsPerHourTarget: 10 } }), { overdueAlertMinutes: 30, callsPerHourTarget: 10 });
  assert.deepEqual(parseReportsSlice({ reports: { callsPerHourTarget: null } }), { overdueAlertMinutes: 60, callsPerHourTarget: null });
  assert.deepEqual(parseReportsSlice(undefined), { overdueAlertMinutes: 60, callsPerHourTarget: null });
});
