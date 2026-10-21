// Выручка по типам услуг (PROCESS 10, D-261): первая покупка клиента и повторные.
import { toKzt } from './definitions';
import type { RevenueSqlRow } from './periodRepo';
import type { RevenueReport, RevenueRow, ResolvedPeriod } from './reportTypes';

function rowOf(serviceTypeKey: string, r: { purchases: number; sumKzt: number; firstPurchases: number; firstSumKzt: number }): RevenueRow {
  return { serviceTypeKey, ...r, repeatPurchases: r.purchases - r.firstPurchases, repeatSumKzt: r.sumKzt - r.firstSumKzt };
}

export function buildRevenueReport(period: ResolvedPeriod, rows: readonly RevenueSqlRow[]): RevenueReport {
  const list = rows
    .map((r) => rowOf(r.serviceTypeKey, { purchases: r.purchases, sumKzt: toKzt(r.sumKzt), firstPurchases: r.firstPurchases, firstSumKzt: toKzt(r.firstSumKzt) }))
    .sort((x, y) => y.sumKzt - x.sumKzt || x.serviceTypeKey.localeCompare(y.serviceTypeKey));
  const sum = (pick: (r: RevenueRow) => number) => list.reduce((s, r) => s + pick(r), 0);
  const { serviceTypeKey: _omit, ...total } = rowOf('', {
    purchases: sum((r) => r.purchases),
    sumKzt: sum((r) => r.sumKzt),
    firstPurchases: sum((r) => r.firstPurchases),
    firstSumKzt: sum((r) => r.firstSumKzt),
  });
  void _omit;
  return { period, rows: list, total };
}
