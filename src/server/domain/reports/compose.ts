// Чистая сборка сводки из строк репозитория: правила подсчёта проверяются юнит-тестом (PROCESS §10.1).
import { distribution } from '@crm/core';
import { ISSUE_KINDS as ISSUE_KIND_LIST, callsPerHour, isBelowTarget } from './definitions';
import type { StaffRow } from './repo';
import type { OperatorRow, OperatorStatus } from './types';

/** Статус на сегодня: отсутствие сильнее паузы; пауза действует только в день `paused_on` (PROCESS 7.5). */
export function operatorStatus(row: Pick<StaffRow, 'pausedOn' | 'absentUntil'>, today: string): OperatorStatus {
  if (row.absentUntil !== null) return 'absent';
  if (row.pausedOn === today) return 'paused';
  return 'working';
}

// «Звонков в час» и мягкая норма — общие определения отчётов.
export { callsPerHour, isBelowTarget };

export interface OperatorInputs {
  staff: readonly StaffRow[];
  today: string;
  cap: number;
  capIncludes: readonly distribution.IssueKind[];
  target: number | null;
  issued: ReadonlyArray<{ toUserId: string; kind: string; n: number }>;
  calls: ReadonlyArray<{ userId: string; outcomes: number; connects: number; lpr: number; hours: number }>;
  bookings: ReadonlyArray<{ userId: string; groups: number; consults: number }>;
  skips: ReadonlyArray<{ userId: string; n: number }>;
  overdue: ReadonlyArray<{ userId: string; n: number }>;
  devices: ReadonlyArray<{ userId: string; pending: number; lastSeenAt: number | null; lastFlushAt: number | null }>;
}

const ISSUE_KINDS: ReadonlySet<string> = new Set(ISSUE_KIND_LIST);

function indexBy<T extends { userId: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.userId, r]));
}

/** Строки таблицы операторов: по одной на участника раздачи, порядок — как в списке сотрудников. */
export function buildOperatorRows(i: OperatorInputs): OperatorRow[] {
  const issuedBy = new Map<string, Partial<Record<distribution.IssueKind, number>>>();
  for (const r of i.issued) {
    if (!ISSUE_KINDS.has(r.kind)) continue;
    const cur = issuedBy.get(r.toUserId) ?? {};
    cur[r.kind as distribution.IssueKind] = r.n;
    issuedBy.set(r.toUserId, cur);
  }
  const calls = indexBy(i.calls);
  const bookings = indexBy(i.bookings);
  const skips = indexBy(i.skips);
  const overdue = indexBy(i.overdue);
  const devices = indexBy(i.devices);
  return i.staff.map((s): OperatorRow => {
    const c = calls.get(s.userId);
    const b = bookings.get(s.userId);
    const d = devices.get(s.userId);
    const outcomes = c?.outcomes ?? 0;
    const hours = c?.hours ?? 0;
    const rate = callsPerHour(outcomes, hours);
    return {
      userId: s.userId,
      name: s.name,
      status: operatorStatus(s, i.today),
      absentUntil: s.absentUntil,
      issued: distribution.capUsed(issuedBy.get(s.userId) ?? {}, i.capIncludes),
      cap: i.cap,
      outcomes,
      connects: c?.connects ?? 0,
      lpr: c?.lpr ?? 0,
      groups: b?.groups ?? 0,
      consults: b?.consults ?? 0,
      skips: skips.get(s.userId)?.n ?? 0,
      overdue: overdue.get(s.userId)?.n ?? 0,
      workedHours: hours,
      callsPerHour: rate,
      belowTarget: isBelowTarget(rate, i.target),
      unsent: d?.pending ?? 0,
      lastSeenAt: d?.lastSeenAt ?? null,
      lastFlushAt: d?.lastFlushAt ?? null,
    };
  });
}

/** Сколько ещё можно выдать сегодня работающим (Σ остатков лимита) — основа «сверх лимита». */
export function roomToday(rows: readonly OperatorRow[]): number {
  return rows.filter((r) => r.status === 'working').reduce((sum, r) => sum + Math.max(0, r.cap - r.issued), 0);
}
