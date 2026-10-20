// Воронка команды за период (PROCESS 10): воронка периода, а не когорта — каждый шаг считает свои события в периоде.
import type { SourceStepRow } from './periodRepo';
import { rate } from './definitions';
import type { Counts } from './operators';
import { FUNNEL_STEPS, type FunnelCounts, type FunnelRow, type FunnelStep, type Rate } from './reportTypes';

export function emptyFunnel(): FunnelCounts {
  return { issued: 0, connected: 0, lpr: 0, booked: 0, attended: 0, purchased: 0 };
}

/** Конверсия шага к предыдущему; у первого шага — null. */
export function funnelRates(c: FunnelCounts): Record<FunnelStep, Rate> {
  const out = {} as Record<FunnelStep, Rate>;
  FUNNEL_STEPS.forEach((step, i) => {
    const prev = FUNNEL_STEPS[i - 1];
    out[step] = prev === undefined ? null : rate(c[step], c[prev]);
  });
  return out;
}

export function funnelRow(key: string, name: string | null, counts: FunnelCounts): FunnelRow {
  return { key, name, counts, rates: funnelRates(counts) };
}

/** Из счётчиков оператора: записи = группы + консультации. */
export function funnelOf(c: Counts): FunnelCounts {
  return { issued: c.issued, connected: c.connects, lpr: c.lpr, booked: c.groups + c.consults, attended: c.attended, purchased: c.purchases };
}

export function addFunnel(into: FunnelCounts, add: FunnelCounts): void {
  for (const s of FUNNEL_STEPS) into[s] += add[s];
}

/** Строки по источникам из шагов репозитория; порядок — по числу выданных, затем по ключу. */
export function funnelBySourceRows(rows: readonly SourceStepRow[]): { rows: FunnelRow[]; total: FunnelRow } {
  const by = new Map<string, FunnelCounts>();
  const total = emptyFunnel();
  for (const r of rows) {
    const c = by.get(r.src) ?? emptyFunnel();
    c[r.step] += r.n;
    total[r.step] += r.n;
    by.set(r.src, c);
  }
  const list = [...by.entries()]
    .sort((x, y) => y[1].issued - x[1].issued || x[0].localeCompare(y[0]))
    .map(([key, c]) => funnelRow(key, null, c));
  return { rows: list, total: funnelRow('', null, total) };
}
