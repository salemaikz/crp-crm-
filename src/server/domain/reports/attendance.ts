// Записи и явка за период (PROCESS 10): по типу события, консультанту или автору записи; по дате встречи, без резерва.
import { rate } from './definitions';
import type { AttendancePurchaseRow, AttendanceSqlRow } from './periodRepo';
import type { AttendanceReport, AttendanceRow, ResolvedPeriod } from './reportTypes';

type Totals = Omit<AttendanceRow, 'key' | 'name'>;

function fin(t: Omit<Totals, 'rate'>): Totals {
  return { ...t, rate: rate(t.attended, t.attended + t.noShow) };
}

export function buildAttendanceReport(i: {
  period: ResolvedPeriod;
  by: AttendanceReport['by'];
  rows: readonly AttendanceSqlRow[];
  purchases: readonly AttendancePurchaseRow[];
  /** Имена для consultant и author; у event_type — подписи строит интерфейс. */
  names: ReadonlyMap<string, string>;
}): AttendanceReport {
  const deals = new Map<string, Set<string>>();
  const allDeals = new Set<string>();
  for (const p of i.purchases) {
    const set = deals.get(p.grp) ?? new Set<string>();
    set.add(p.dealId);
    deals.set(p.grp, set);
    allDeals.add(p.dealId);
  }
  const groups = new Set([...i.rows.map((r) => r.grp), ...deals.keys()]);
  const byGrp = new Map(i.rows.map((r) => [r.grp, r]));
  const rows: AttendanceRow[] = [...groups].map((key) => {
    const r = byGrp.get(key);
    const t = fin({
      booked: r?.booked ?? 0,
      attended: r?.attended ?? 0,
      noShow: r?.noShow ?? 0,
      unmarked: r?.unmarked ?? 0,
      cancelled: r?.cancelled ?? 0,
      purchases: deals.get(key)?.size ?? 0,
    });
    return { key, name: i.by === 'event_type' || key === '' ? null : (i.names.get(key) ?? ''), ...t };
  });
  rows.sort((x, y) => y.booked - x.booked || x.key.localeCompare(y.key));
  const sum = (pick: (r: AttendanceRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  // Покупки в итоге — различные сделки: одна сделка с записями в двух группах считается один раз
  const total = fin({
    booked: sum((r) => r.booked),
    attended: sum((r) => r.attended),
    noShow: sum((r) => r.noShow),
    unmarked: sum((r) => r.unmarked),
    cancelled: sum((r) => r.cancelled),
    purchases: allDeals.size,
  });
  return { period: i.period, by: i.by, rows, total };
}
