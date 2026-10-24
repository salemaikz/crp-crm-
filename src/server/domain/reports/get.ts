// Отчёты за период (R3a): единый вход для страницы, API и выгрузки. Охват пространства проверяется здесь;
// SQL — в periodRepo.ts, сборка — в operators/funnel/revenue/attendance/reasons.
import { calling, time } from '@crm/core';
import { getDb } from '@/server/platform/db';
import { requirePeriodReports } from './access';
import { reportsDeps } from './deps';
import { ISSUE_KINDS, REASON_OUTCOME_KINDS } from './definitions';
import { addFunnel, addKinds, emptyFunnel, emptyKinds, funnelBySourceRows, funnelOf, funnelRow, kindsByKey } from './funnel';
import { buildAttendanceList, buildAttendanceReport, decodeListCursor } from './attendance';
import { addCounts, buildOperatorsReport, emptyCounts, loadNames, loadUserDayCells, type Counts } from './operators';
import { defaultPeriod, resolvePeriod } from './period';
import {
  attendanceGroups,
  attendanceListCounts,
  attendanceListRows,
  attendancePurchases,
  funnelBySource,
  funnelKindsBySource,
  funnelKindsByUser,
  reasonCounts,
  revenueByServiceType,
  userNames,
  type PeriodArgs,
} from './periodRepo';
import { buildReasonsReport } from './reasons';
import { loadReasonColumns } from './settings';
import { buildRevenueReport } from './revenue';
import { BadRequestError } from '@/server/access';
import { ExportTooLargeError } from './exportErrors';
import { type AttendanceListReport, type FunnelReport, type GetReport, type PeriodInput, type ReportQuery, type ReportResult } from './reportTypes';

export const getReport: GetReport = async <Q extends ReportQuery>(viewer: Parameters<GetReport>[0], q: Q): Promise<ReportResult<Q>> => {
  const spaceId = requirePeriodReports(viewer);
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
      return buildOperatorsReport({ period, grouping: q.grouping, target: cfg.callsPerHourTarget, cells, names, participants }) as ReportResult<Q>;
    }
    case 'funnel': {
      let report: FunnelReport;
      if (q.by === 'source') {
        const [rows, kindRows] = await Promise.all([
          funnelBySource(viewer, sql, { ...a, connectedKinds: calling.CONNECTED_KINDS, issueKinds: ISSUE_KINDS }),
          funnelKindsBySource(viewer, sql, a),
        ]);
        report = { period, by: 'source', ...funnelBySourceRows(rows, kindsByKey(kindRows)) };
      } else {
        const [cells, kindRows] = await Promise.all([loadUserDayCells(viewer, sql, a), funnelKindsByUser(viewer, sql, a)]);
        const kinds = kindsByKey(kindRows);
        const per = new Map<string, Counts>();
        for (const c of cells) {
          const acc = per.get(c.userId) ?? emptyCounts();
          addCounts(acc, c.counts);
          per.set(c.userId, acc);
        }
        const { names } = await loadNames(sql, { spaceId, roles, today, userIds: a.userIds }, per.keys());
        const total = emptyFunnel();
        const totalKinds = emptyKinds();
        const rows = [...per.entries()].map(([id, counts]) => {
          const f = funnelOf(counts);
          addFunnel(total, f);
          const k = kinds.get(id) ?? emptyKinds();
          addKinds(totalKinds, k);
          return funnelRow(id, names.get(id) ?? '', f, k);
        });
        rows.sort((x, y) => y.counts.issued - x.counts.issued || (x.name ?? '').localeCompare(y.name ?? '', 'ru') || x.key.localeCompare(y.key));
        report = { period, by: 'operator', rows, total: funnelRow('', null, total, totalKinds) };
      }
      return report as ReportResult<Q>;
    }
    case 'revenue':
      return buildRevenueReport(period, await revenueByServiceType(viewer, sql, a)) as ReportResult<Q>;
    case 'attendance': {
      if (q.view === 'list') {
        const after = q.list.cursor === null ? null : decodeListCursor(q.list.cursor);
        if (q.list.cursor !== null && after === null) throw new BadRequestError('invalid');
        const limit = Math.max(1, Math.trunc(q.list.limit));
        const [rows, counts] = await Promise.all([
          attendanceListRows(viewer, sql, { ...a, now, eventType: q.list.eventType, status: q.list.status, consultant: q.list.consultant, after, limit: limit + 1 }),
          // чипы над таблицей считаются один раз, на первой странице
          after === null ? attendanceListCounts(viewer, sql, { ...a, now, eventType: q.list.eventType, consultant: q.list.consultant }) : Promise.resolve(null),
        ]);
        return buildAttendanceList({ period, rows, limit, counts }) as ReportResult<Q>;
      }
      const [rows, purchases] = await Promise.all([
        attendanceGroups(viewer, sql, { ...a, by: q.by, now }),
        attendancePurchases(viewer, sql, { ...a, by: q.by }),
      ]);
      const names = new Map<string, string>();
      if (q.by !== 'event_type') {
        const ids = new Set([...rows.map((r) => r.grp), ...purchases.map((p) => p.grp)].filter((g) => g !== ''));
        for (const u of await userNames(sql, [...ids])) names.set(u.id, u.name);
      }
      return buildAttendanceReport({ period, by: q.by, rows, purchases, names }) as ReportResult<Q>;
    }
    case 'reasons': {
      // Блоки по колонкам доски пресета (роли «мусор» и «перезвон»); нет настроек — только прежние группы
      const columns = await (deps.reasonColumns ?? loadReasonColumns)(spaceId);
      return buildReasonsReport(period, await reasonCounts(viewer, sql, { ...a, closingKinds: REASON_OUTCOME_KINDS }), columns) as ReportResult<Q>;
    }
  }
};

/** Период по умолчанию (текущая неделя в поясе установки) и «сегодня»: для маршрута и страницы. */
export async function getDefaultPeriod(viewer: Parameters<GetReport>[0]): Promise<{ period: PeriodInput; today: string; timeZone: string }> {
  const spaceId = requirePeriodReports(viewer);
  const deps = reportsDeps();
  const cfg = await deps.config(spaceId, deps.now());
  const timeZone = cfg.distribution.timeZone;
  const today = time.localDayOf(deps.now(), timeZone);
  return { period: defaultPeriod(today), today, timeZone };
}

/** Больше строк поимённого списка в одну выгрузку не отдаём (период ≤ 92 дней). */
export const ATTENDANCE_EXPORT_MAX_ROWS = 20000;
const EXPORT_PAGE = 500;

/**
 * Список явки целиком для выгрузки: страницы по курсору подряд, от курсора запроса (обычно с начала). Охват и права —
 * те же, что у экрана: каждая страница идёт через getReport.
 */
export async function getAttendanceListAll(viewer: Parameters<GetReport>[0], q: Extract<ReportQuery, { key: 'attendance'; view: 'list' }>): Promise<AttendanceListReport> {
  let cursor = q.list.cursor;
  let first: AttendanceListReport | null = null;
  const rows: AttendanceListReport['rows'] = [];
  for (;;) {
    const page: AttendanceListReport = await getReport(viewer, { ...q, list: { ...q.list, cursor, limit: EXPORT_PAGE } });
    first ??= page;
    rows.push(...page.rows);
    if (rows.length > ATTENDANCE_EXPORT_MAX_ROWS) throw new ExportTooLargeError();
    if (page.next === null) return { period: first.period, rows, next: null, counts: first.counts };
    cursor = page.next;
  }
}
