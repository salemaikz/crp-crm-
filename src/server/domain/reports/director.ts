// Панель директора (R4, D-265): текущая и прошлая неделя из тех же функций отчётов и сводки, что видит РОП.
// Только чтение; собственного SQL нет. Охват пространства и `report.view` проверяют getReport и getSummary.
import { time } from '@crm/core';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { requirePeriodReports } from './access';
import { reportsDeps } from './deps';
import { getReport } from './get';
import { purchasesWithoutBooking } from './periodRepo';
import { getDb } from '@/server/platform/db';
import { previousWeek, weekOf } from './period';
import { DIRECTOR_WEEKS, type DirectorWeek } from './reportTypes';
import { getSummary } from './summary';
import type { GetDirectorDashboard, PeriodInput, ReportFilters } from './reportTypes';

const NO_FILTERS: ReportFilters = { userIds: null, sourceKey: null };

/** Запас в рабочих днях: пул / ёмкость выдачи за день, один знак; ёмкость 0 — null. */
export function stockDays(poolReady: number, capacityPerDay: number): number | null {
  if (capacityPerDay <= 0) return null;
  return Math.round((poolReady / capacityPerDay) * 10) / 10;
}

export type EventTypeDoc = { key: string; behavior: string; short?: { ru?: string }; label: { ru?: string } };

/** Короткие подписи плиток «Записи»: первый групповой и первый индивидуальный вид из booking.eventTypes. */
export function eventShortLabels(eventTypes: readonly EventTypeDoc[]): { group: string; individual: string } {
  const name = (behavior: string): string => {
    const e = eventTypes.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label.ru ?? e.key) : '';
  };
  return { group: name('group'), individual: name('individual') };
}

/** `?week=` панели: закрытый список, всё неизвестное — текущая неделя. */
export function parseDirectorWeek(raw: unknown): DirectorWeek {
  return DIRECTOR_WEEKS.find((w) => w === raw) ?? 'current';
}

/** Показанная неделя и неделя для сравнения: текущая (пн…сегодня) против прошлой, прошлая — против предыдущей. */
export function directorWeeks(today: string, which: DirectorWeek): { week: PeriodInput; prev: PeriodInput } {
  if (which === 'prev') return { week: previousWeek(today), prev: previousWeek(time.addLocalDays(today, -7)) };
  return { week: { from: weekOf(today), to: today }, prev: previousWeek(today) };
}

const REASONS_TOP = 5;

export const getDirectorDashboard: GetDirectorDashboard = async (viewer, opts = {}) => {
  requirePeriodReports(viewer);
  const deps = reportsDeps();
  const now = deps.now();
  const cfg = await deps.config(viewer.spaceId as string, now);
  const today = time.localDayOf(now, cfg.distribution.timeZone);
  const weekKey = parseDirectorWeek(opts.week);
  const { week, prev } = directorWeeks(today, weekKey);

  const active = await getActiveConfigOrNull(); // нет ревизии настроек (тесты без пресета) — подписей нет, плитки записей скрыты
  const space = Object.values(active?.spaces ?? {}).find((s) => s.spaceId === viewer.spaceId)?.doc;
  const eventLabels = eventShortLabels((space?.booking.eventTypes ?? []) as readonly EventTypeDoc[]);

  const [ops, prevOps, funnel, revenue, attendanceReport, reasonsReport, summary] = await Promise.all([
    getReport(viewer, { key: 'operators', period: week, filters: NO_FILTERS, grouping: 'total' }),
    getReport(viewer, { key: 'operators', period: prev, filters: NO_FILTERS, grouping: 'total' }),
    getReport(viewer, { key: 'funnel', period: week, filters: NO_FILTERS, by: 'operator' }),
    getReport(viewer, { key: 'revenue', period: week, filters: NO_FILTERS }),
    getReport(viewer, { key: 'attendance', period: week, filters: NO_FILTERS, by: 'event_type' }),
    getReport(viewer, { key: 'reasons', period: week, filters: NO_FILTERS }),
    getSummary(viewer),
  ]);

  const p = ops.period;
  const withoutBooking = await purchasesWithoutBooking(viewer, (await getDb()).sql, {
    spaceId: viewer.spaceId as string,
    fromMs: p.fromMs,
    toMs: p.toMs,
    from: p.from,
    to: p.to,
    timeZone: p.timeZone,
    userIds: null,
    sourceKey: null,
  });
  const trash = reasonsReport.blocks.find((b) => b.role === 'trash');
  const t = ops.totals;
  const capacityPerDay = summary.tiles.issued.cap;
  const poolReady = summary.tiles.pool.ready;
  return {
    generatedAt: now,
    weekKey,
    reasons: trash ? { key: trash.key, label: trash.label, total: trash.total, top: trash.rows.slice(0, REASONS_TOP) } : null,
    week: ops.period,
    prevWeek: prevOps.period,
    calls: { outcomes: t.outcomes, connects: t.connects, prevOutcomes: prevOps.totals.outcomes, prevConnects: prevOps.totals.connects },
    eventLabels,
    bookings: { groups: t.groups, consults: t.consults },
    // unmarked — записи недели, чья дата прошла, а явка не отмечена: в «из отмеченных» не входят
    attendance: { attended: t.attended, noShow: t.noShow, rate: t.attendanceRate, unmarked: attendanceReport.total.unmarked },
    // «Средняя конверсия операторов»: среднее «записи / дозвоны» операторов с ≥ minConnects дозвонов, рядом — по команде
    conversion: { average: ops.average.bookedPerConnect, team: t.bookedPerConnect, operators: ops.average.operators, minConnects: ops.average.minConnects },
    purchases: {
      count: t.purchases,
      sumKzt: t.purchaseSumKzt,
      prevCount: prevOps.totals.purchases,
      prevSumKzt: prevOps.totals.purchaseSumKzt,
      withoutBooking,
    },
    funnel: funnel.total,
    revenue: revenue.rows,
    stock: { poolReady, capacityPerDay, days: stockDays(poolReady, capacityPerDay) },
  };
};
