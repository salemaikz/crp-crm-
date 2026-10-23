// Отчёт «Операторы» за период (PROCESS 10.2, D-261, D-262): строки «сотрудник × корзина» собираются в JS из
// строк «сотрудник × местный день» (≤ 50 сотрудников × 92 дня). Часы в работе за период — сумма по дням.
import { calling } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { AVERAGE_MIN_CONNECTS, callsPerHour, isBelowTarget, ISSUE_KINDS, meanRate, rate, toKzt } from './definitions';
import { bucketOf } from './period';
import {
  attendanceByUserDay,
  bookedByUserDay,
  callsByUserDay,
  issuedByUserDay,
  lprFirstByUserDay,
  purchasesByUserDay,
  skipsByUserDay,
  userNames,
  type PeriodArgs,
} from './periodRepo';
import { selectStaff } from './repo';
import type { Grouping, OperatorMetrics, OperatorPeriodRow, OperatorsAverage, OperatorsReport, ResolvedPeriod } from './reportTypes';

/** Счётчики без производных (доли и «звонков в час» считаются после суммирования). */
export type Counts = Omit<OperatorMetrics, 'attendanceRate' | 'callsPerHour' | 'bookedPerConnect' | 'attendedPerBooked' | 'purchasedPerAttended'>;

export function emptyCounts(): Counts {
  return {
    issued: 0,
    outcomes: 0,
    connects: 0,
    lpr: 0,
    groups: 0,
    consults: 0,
    attended: 0,
    noShow: 0,
    purchases: 0,
    purchaseSumKzt: 0,
    skips: 0,
    workedHours: 0,
  };
}

export function addCounts(into: Counts, add: Partial<Counts>): void {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += add[k] ?? 0;
}

/** Производные показатели поверх сумм. */
export function finishCounts(c: Counts): OperatorMetrics {
  const booked = c.groups + c.consults;
  return {
    ...c,
    attendanceRate: rate(c.attended, c.attended + c.noShow),
    bookedPerConnect: rate(booked, c.connects),
    attendedPerBooked: rate(c.attended, booked),
    purchasedPerAttended: rate(c.purchases, c.attended),
    callsPerHour: callsPerHour(c.outcomes, c.workedHours),
  };
}

/** Средняя по операторам: среднее долей тех, у кого за период хватает дозвонов (D-343); не конверсия команды. */
export function averageConversions(perUser: Iterable<Counts>, minConnects: number = AVERAGE_MIN_CONNECTS): OperatorsAverage {
  const eligible = [...perUser].filter((c) => c.connects >= minConnects).map(finishCounts);
  return {
    operators: eligible.length,
    minConnects,
    bookedPerConnect: meanRate(eligible.map((m) => m.bookedPerConnect)),
    attendedPerBooked: meanRate(eligible.map((m) => m.attendedPerBooked)),
    purchasedPerAttended: meanRate(eligible.map((m) => m.purchasedPerAttended)),
  };
}

export interface UserDayCell {
  userId: string;
  day: string;
  counts: Counts;
}

/** Все семь запросов параллельно → ячейки «сотрудник × день». Число запросов постоянно. */
export async function loadUserDayCells(viewer: Viewer, sql: Sql, a: PeriodArgs): Promise<UserDayCell[]> {
  const [calls, lpr, issued, booked, attended, purchases, skips] = await Promise.all([
    callsByUserDay(viewer, sql, { ...a, connectedKinds: calling.CONNECTED_KINDS }),
    lprFirstByUserDay(viewer, sql, a),
    issuedByUserDay(sql, { ...a, issueKinds: ISSUE_KINDS }),
    bookedByUserDay(viewer, sql, a),
    attendanceByUserDay(viewer, sql, a),
    purchasesByUserDay(viewer, sql, a),
    skipsByUserDay(sql, a),
  ]);
  const cells = new Map<string, UserDayCell>();
  const cell = (userId: string, day: string): Counts => {
    const key = `${userId}\u0000${day}`;
    let c = cells.get(key);
    if (!c) {
      c = { userId, day, counts: emptyCounts() };
      cells.set(key, c);
    }
    return c.counts;
  };
  for (const r of calls) addCounts(cell(r.userId, r.day), { outcomes: r.outcomes, connects: r.connects, workedHours: r.hours });
  for (const r of lpr) addCounts(cell(r.userId, r.day), { lpr: r.lpr });
  for (const r of issued) addCounts(cell(r.userId, r.day), { issued: r.issued });
  for (const r of booked) addCounts(cell(r.userId, r.day), { groups: r.groups, consults: r.consults });
  for (const r of attended) addCounts(cell(r.userId, r.day), { attended: r.attended, noShow: r.noShow });
  for (const r of purchases) addCounts(cell(r.userId, r.day), { purchases: r.purchases, purchaseSumKzt: toKzt(r.sumKzt) });
  for (const r of skips) addCounts(cell(r.userId, r.day), { skips: r.skips });
  return [...cells.values()];
}

/** Имена: участники раздачи (с фильтром) плюс все, у кого есть числа. */
export async function loadNames(
  sql: Sql,
  a: { spaceId: string; roles: readonly string[]; today: string; userIds: string[] | null },
  withData: Iterable<string>,
): Promise<{ names: Map<string, string>; participants: string[] }> {
  const staff = await selectStaff(sql, { spaceId: a.spaceId, roles: a.roles, today: a.today });
  const names = new Map<string, string>();
  const participants: string[] = [];
  const filter = a.userIds ? new Set(a.userIds) : null;
  for (const s of staff) {
    if (filter && !filter.has(s.userId)) continue;
    names.set(s.userId, s.name);
    participants.push(s.userId);
  }
  const missing = [...new Set(withData)].filter((id) => !names.has(id));
  for (const u of await userNames(sql, missing)) names.set(u.id, u.name);
  return { names, participants };
}

export function buildOperatorsReport(i: {
  period: ResolvedPeriod;
  grouping: Grouping;
  target: number | null;
  cells: readonly UserDayCell[];
  names: ReadonlyMap<string, string>;
  participants: readonly string[];
}): OperatorsReport {
  const buckets = new Map<string, { userId: string; bucket: string; counts: Counts }>();
  const totals = emptyCounts();
  const perUser = new Map<string, Counts>();
  // В среднюю входят только операторы (участники раздачи): руководитель, вносящий итоги вручную, в неё не идёт
  const participantSet = new Set(i.participants);
  for (const c of i.cells) {
    const u = perUser.get(c.userId) ?? emptyCounts();
    addCounts(u, c.counts);
    perUser.set(c.userId, u);
    const bucket = bucketOf(c.day, i.grouping);
    const key = `${c.userId}\u0000${bucket}`;
    let b = buckets.get(key);
    if (!b) {
      b = { userId: c.userId, bucket, counts: emptyCounts() };
      buckets.set(key, b);
    }
    addCounts(b.counts, c.counts);
    addCounts(totals, c.counts);
  }
  // В общей корзине участники раздачи видны и без чисел
  if (i.grouping === 'total') {
    for (const id of i.participants) {
      const key = `${id}\u0000total`;
      if (!buckets.has(key)) buckets.set(key, { userId: id, bucket: 'total', counts: emptyCounts() });
    }
  }
  const rows: OperatorPeriodRow[] = [...buckets.values()].map((b) => {
    const m = finishCounts(b.counts);
    return { ...m, userId: b.userId, name: i.names.get(b.userId) ?? '', bucket: b.bucket, belowTarget: isBelowTarget(m.callsPerHour, i.target) };
  });
  rows.sort((x, y) => x.name.localeCompare(y.name, 'ru') || x.userId.localeCompare(y.userId) || x.bucket.localeCompare(y.bucket));
  return { period: i.period, grouping: i.grouping, callsPerHourTarget: i.target, rows, totals: finishCounts(totals), average: averageConversions([...perUser].filter(([id]) => participantSet.has(id)).map(([, c]) => c)) };
}
