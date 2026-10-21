// Причины отказов за период: итоги «не интересно / не целевой / не звонить» и потерянные сделки; доля внутри группы.
import { rate } from './definitions';
import type { ReasonSqlRow } from './periodRepo';
import type { ReasonRow, ReasonsReport, ResolvedPeriod } from './reportTypes';

const GROUP_ORDER: readonly ReasonRow['group'][] = ['not_interested', 'not_target', 'do_not_call', 'deal_lost'];

export function buildReasonsReport(period: ResolvedPeriod, rows: readonly ReasonSqlRow[]): ReasonsReport {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.grp, (totals.get(r.grp) ?? 0) + r.n);
  const list: ReasonRow[] = rows
    .filter((r): r is ReasonSqlRow & { grp: ReasonRow['group'] } => GROUP_ORDER.includes(r.grp as ReasonRow['group']))
    .map((r) => ({ group: r.grp, reasonCode: r.reasonCode, count: r.n, share: rate(r.n, totals.get(r.grp) ?? 0) }));
  list.sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group) || y.count - x.count || x.reasonCode.localeCompare(y.reasonCode));
  return { period, rows: list };
}
