// Причины за период: перезвон (в том числе «без причины»), отказы, списание, потерянные сделки и неявки по видам
// мероприятий (D-344). Доля считается внутри группы.
import { rate } from './definitions';
import type { ReasonSqlRow } from './periodRepo';
import { REASON_GROUPS, type ReasonGroup, type ReasonRow, type ReasonsReport, type ResolvedPeriod } from './reportTypes';

const GROUP_SET: ReadonlySet<string> = new Set(REASON_GROUPS);

export function buildReasonsReport(period: ResolvedPeriod, rows: readonly ReasonSqlRow[]): ReasonsReport {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.grp, (totals.get(r.grp) ?? 0) + r.n);
  const list: ReasonRow[] = rows
    .filter((r): r is ReasonSqlRow & { grp: ReasonGroup } => GROUP_SET.has(r.grp))
    .map((r) => ({ group: r.grp, reasonCode: r.reasonCode, count: r.n, share: rate(r.n, totals.get(r.grp) ?? 0) }));
  list.sort((x, y) => REASON_GROUPS.indexOf(x.group) - REASON_GROUPS.indexOf(y.group) || y.count - x.count || x.reasonCode.localeCompare(y.reasonCode));
  return { period, rows: list };
}
