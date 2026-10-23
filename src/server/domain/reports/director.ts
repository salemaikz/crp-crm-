// Панель директора (R4, D-265): текущая и прошлая неделя из тех же функций отчётов и сводки, что видит РОП.
// Только чтение; собственного SQL нет. Охват пространства и `report.view` проверяют getReport и getSummary.
import { time } from '@crm/core';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { requirePeriodReports } from './access';
import { reportsDeps } from './deps';
import { getReport } from './get';
import { previousWeek, weekOf } from './period';
import { getSummary } from './summary';
import type { GetDirectorDashboard, ReportFilters } from './reportTypes';

const NO_FILTERS: ReportFilters = { userIds: null, sourceKey: null };

/** Запас в рабочих днях: пул / ёмкость выдачи за день, один знак; ёмкость 0 — null. */
export function stockDays(poolReady: number, capacityPerDay: number): number | null {
  if (capacityPerDay <= 0) return null;
  return Math.round((poolReady / capacityPerDay) * 10) / 10;
}

type EventTypeDoc = { key: string; behavior: string; short?: { ru?: string }; label: { ru?: string } };

/** Короткие подписи плиток «Записи»: первый групповой и первый индивидуальный вид из booking.eventTypes. */
export function eventShortLabels(eventTypes: readonly EventTypeDoc[]): { group: string; individual: string } {
  const name = (behavior: string): string => {
    const e = eventTypes.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label.ru ?? e.key) : '';
  };
  return { group: name('group'), individual: name('individual') };
}

export const getDirectorDashboard: GetDirectorDashboard = async (viewer) => {
  requirePeriodReports(viewer);
  const deps = reportsDeps();
  const now = deps.now();
  const cfg = await deps.config(viewer.spaceId as string, now);
  const today = time.localDayOf(now, cfg.distribution.timeZone);
  const week = { from: weekOf(today), to: today };
  const prev = previousWeek(today);

  const active = await getActiveConfigOrNull(); // нет ревизии настроек (тесты без пресета) — подписей нет, плитки записей скрыты
  const space = Object.values(active?.spaces ?? {}).find((s) => s.spaceId === viewer.spaceId)?.doc;
  const eventLabels = eventShortLabels((space?.booking.eventTypes ?? []) as readonly EventTypeDoc[]);

  const [ops, prevOps, funnel, revenue, summary] = await Promise.all([
    getReport(viewer, { key: 'operators', period: week, filters: NO_FILTERS, grouping: 'total' }),
    getReport(viewer, { key: 'operators', period: prev, filters: NO_FILTERS, grouping: 'total' }),
    getReport(viewer, { key: 'funnel', period: week, filters: NO_FILTERS, by: 'operator' }),
    getReport(viewer, { key: 'revenue', period: week, filters: NO_FILTERS }),
    getSummary(viewer),
  ]);

  const t = ops.totals;
  const capacityPerDay = summary.tiles.issued.cap;
  const poolReady = summary.tiles.pool.ready;
  return {
    generatedAt: now,
    week: ops.period,
    prevWeek: prevOps.period,
    calls: { outcomes: t.outcomes, connects: t.connects, prevOutcomes: prevOps.totals.outcomes, prevConnects: prevOps.totals.connects },
    eventLabels,
    bookings: { groups: t.groups, consults: t.consults },
    attendance: { attended: t.attended, noShow: t.noShow, rate: t.attendanceRate },
    purchases: {
      count: t.purchases,
      sumKzt: t.purchaseSumKzt,
      prevCount: prevOps.totals.purchases,
      prevSumKzt: prevOps.totals.purchaseSumKzt,
    },
    funnel: funnel.total,
    revenue: revenue.rows,
    stock: { poolReady, capacityPerDay, days: stockDays(poolReady, capacityPerDay) },
  };
};
