// Причины за период: перезвон (в том числе «без причины»), отказы, списание, потерянные сделки и неявки по видам
// мероприятий (D-344). Доля считается внутри группы.
import { rate } from './definitions';
import type { ReasonSqlRow } from './periodRepo';
import { REASON_GROUPS, type ReasonBlock, type ReasonGroup, type ReasonRow, type ReasonsReport, type ResolvedPeriod } from './reportTypes';

const GROUP_SET: ReadonlySet<string> = new Set(REASON_GROUPS);

const CLOSED_STATES = ['not_interested', 'not_target', 'do_not_call', 'written_off'];

/** Колонка доски для блока «Причины»: роль определяется состояниями, как в ядре доски (`roleOf`). */
export interface ReasonColumn {
  key: string;
  label: string | null;
  role: 'trash' | 'callback';
  states: readonly string[];
}

/** Колонки ролей «мусор» и «перезвон» из `board.columns` пресета; остальные (новые, разбор, покупка) в отчёт причин не идут. */
export function reasonColumns(columns: ReadonlyArray<{ key: string; label: string | null; states: readonly string[] }>): ReasonColumn[] {
  const out: ReasonColumn[] = [];
  for (const c of columns) {
    if (c.states.includes('agreed') || c.states.includes('client')) continue;
    if (c.states.some((s) => CLOSED_STATES.includes(s))) out.push({ ...c, role: 'trash' });
    else if (c.states.includes('retry') || c.states.includes('callback')) out.push({ ...c, role: 'callback' });
  }
  return out;
}

function blocksOf(list: readonly ReasonRow[], columns: readonly ReasonColumn[]): ReasonBlock[] {
  return columns.map((c) => {
    const mine = list.filter((r) => c.states.includes(r.group)).sort((x, y) => y.count - x.count || REASON_GROUPS.indexOf(x.group) - REASON_GROUPS.indexOf(y.group) || x.reasonCode.localeCompare(y.reasonCode));
    const total = mine.reduce((s, r) => s + r.count, 0);
    return { key: c.key, label: c.label, role: c.role, total, rows: mine.map((r) => ({ ...r, share: rate(r.count, total) })) };
  });
}

export function buildReasonsReport(period: ResolvedPeriod, rows: readonly ReasonSqlRow[], columns: readonly ReasonColumn[] = []): ReasonsReport {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.grp, (totals.get(r.grp) ?? 0) + r.n);
  const list: ReasonRow[] = rows
    .filter((r): r is ReasonSqlRow & { grp: ReasonGroup } => GROUP_SET.has(r.grp))
    .map((r) => ({ group: r.grp, reasonCode: r.reasonCode, count: r.n, share: rate(r.n, totals.get(r.grp) ?? 0) }));
  list.sort((x, y) => REASON_GROUPS.indexOf(x.group) - REASON_GROUPS.indexOf(y.group) || y.count - x.count || x.reasonCode.localeCompare(y.reasonCode));
  return { period, rows: list, blocks: blocksOf(list, columns) };
}
