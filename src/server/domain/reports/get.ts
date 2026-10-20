// Отчёты за период (R3a): единый вход для страницы, API и выгрузки. Охват пространства проверяется здесь;
// SQL — в periodRepo.ts, сборка — в operators/funnel/revenue/attendance/reasons.
import { calling, time } from '@crm/core';
import { getDb } from '@/server/platform/db';
import { requireSpaceReports } from './access';
import { reportsDeps } from './deps';
import { CLOSING_KINDS, ISSUE_KINDS } from './definitions';
import { addFunnel, emptyFunnel, funnelBySourceRows, funnelOf, funnelRow } from './funnel';
import { buildAttendanceReport } from './attendance';
import { addCounts, buildOperatorsReport, emptyCounts, loadNames, loadUserDayCells, type Counts } from './operators';
import { defaultPeriod, resolvePeriod } from './period';
import { attendanceGroups, attendancePurchases, funnelBySource, reasonCounts, revenueByServiceType, userNames, type PeriodArgs } from './periodRepo';
import { buildReasonsReport } from './reasons';
import { buildRevenueReport } from './revenue';
import { type FunnelReport, type GetReport, type PeriodInput, type ReportOf, type ReportQuery } from './reportTypes';

export const getReport: GetReport = async <Q extends ReportQuery>(viewer: Parameters<GetReport>[0], q: Q): Promise<ReportOf<Q['key']>> => {
  const spaceId = requireSpaceReports(viewer);
  const deps = reportsDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const tz = cfg.distribution.timeZone;
  const period = resolvePeriod(q.period, tz, now);
  const sql = (await getDb()).sql;
  const a: PeriodArgs = {
    spaceId,
    fromMs: period.fromMs,
    toMs: period.toMs,
    from: period.from,
    to: period.to,
    timeZone: tz,
    userIds: q.filters.userIds,
    sourceKey: q.filters.sourceKey,
  };
  const today = time.localDayOf(now, tz);
  const roles = cfg.distribution.participantRoles;

  switch (q.key) {
    case 'operators': {
      const cells = await loadUserDayCells(viewer, sql, a);
      const { names, participants } = await loadNames(sql, { spaceId, roles, today, userIds: a.userIds }, cells.map((c) => c.userId));
      return buildOperatorsReport({ period, grouping: q.grouping, target: cfg.callsPerHourTarget, cells, names, participants }) as ReportOf<Q['key']>;
    }
    case 'funnel': {
      let report: FunnelReport;
      if (q.by === 'source') {
        const rows = await funnelBySource(viewer, sql, { ...a, connectedKinds: calling.CONNECTED_KINDS, issueKinds: ISSUE_KINDS });
        report = { period, by: 'source', ...funnelBySourceRows(rows) };
      } else {
        const cells = await loadUserDayCells(viewer, sql, a);
        const per = new Map<string, Counts>();
        for (const c of cells) {
          const acc = per.get(c.userId) ?? emptyCounts();
          addCounts(acc, c.counts);
          per.set(c.userId, acc);
        }
        const { names } = await loadNames(sql, { spaceId, roles, today, userIds: a.userIds }, per.keys());
        const total = emptyFunnel();
        const rows = [...per.entries()].map(([id, counts]) => {
          const f = funnelOf(counts);
          addFunnel(total, f);
          return funnelRow(id, names.get(id) ?? '', f);
        });
        rows.sort((x, y) => y.counts.issued - x.counts.issued || (x.name ?? '').localeCompare(y.name ?? '', 'ru') || x.key.localeCompare(y.key));
        report = { period, by: 'operator', rows, total: funnelRow('', null, total) };
      }
      return report as ReportOf<Q['key']>;
    }
    case 'revenue':
      return buildRevenueReport(period, await revenueByServiceType(viewer, sql, a)) as ReportOf<Q['key']>;
    case 'attendance': {
      const [rows, purchases] = await Promise.all([
        attendanceGroups(viewer, sql, { ...a, by: q.by, now }),
        attendancePurchases(viewer, sql, { ...a, by: q.by }),
      ]);
      const names = new Map<string, string>();
      if (q.by !== 'event_type') {
        const ids = new Set([...rows.map((r) => r.grp), ...purchases.map((p) => p.grp)].filter((g) => g !== ''));
        for (const u of await userNames(sql, [...ids])) names.set(u.id, u.name);
      }
      return buildAttendanceReport({ period, by: q.by, rows, purchases, names }) as ReportOf<Q['key']>;
    }
    case 'reasons':
      return buildReasonsReport(period, await reasonCounts(viewer, sql, { ...a, closingKinds: CLOSING_KINDS })) as ReportOf<Q['key']>;
  }
};

/** Период по умолчанию (текущая неделя в поясе установки) и «сегодня»: для маршрута и страницы. */
export async function getDefaultPeriod(viewer: Parameters<GetReport>[0]): Promise<{ period: PeriodInput; today: string; timeZone: string }> {
  const spaceId = requireSpaceReports(viewer);
  const deps = reportsDeps();
  const cfg = await deps.config(spaceId, deps.now());
  const timeZone = cfg.distribution.timeZone;
  const today = time.localDayOf(deps.now(), timeZone);
  return { period: defaultPeriod(today), today, timeZone };
}
