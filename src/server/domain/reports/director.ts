// Панель директора (R4, D-265): текущая и прошлая неделя из тех же функций отчётов и сводки, что видит РОП.
// Только чтение; собственного SQL нет. Охват пространства и `report.view` проверяют getReport и getSummary.
import { time } from '@crm/core';
import { requirePeriodReports } from './access';
import { reportsDeps } from './deps';
import { loadEventLabels } from './eventLabels';
import { getReport } from './get';
import { purchasesWithoutBooking } from './periodRepo';
import { getDb } from '@/server/platform/db';
import { previousWeek, weekOf } from './period';
import { DIRECTOR_WEEKS, type DirectorWeek } from './reportTypes';
import { getSummary } from './summary';
import type { DirectorReasons, GetDirectorDashboard, PeriodInput, ReportFilters } from './reportTypes';

const NO_FILTERS: ReportFilters = { userIds: null, sourceKey: null };

export { eventShortLabels, type EventTypeDoc } from './eventLabels';

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

  const eventLabels = await loadEventLabels(viewer.spaceId as string); // нет настроек — подписей нет, плитки записей скрыты

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
  const reasonsOf = (role: 'trash' | 'callback'): DirectorReasons | null => {
    const b = reasonsReport.blocks.find((x) => x.role === role);
    return b ? { key: b.key, label: b.label, total: b.total, top: b.rows.slice(0, REASONS_TOP) } : null;
  };
  const t = ops.totals;
  const poolReady = summary.tiles.pool.ready;
  return {
    generatedAt: now,
    weekKey,
    reasons: { trash: reasonsOf('trash'), callback: reasonsOf('callback') },
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
    stock: { poolReady },
  };
};
