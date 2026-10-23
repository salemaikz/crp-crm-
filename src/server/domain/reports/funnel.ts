// Воронка команды за период (PROCESS 10): воронка периода, а не когорта — каждый шаг считает свои события в периоде.
import type { FunnelKindStepRow, SourceStepRow } from './periodRepo';
import { rate } from './definitions';
import type { Counts } from './operators';
import {
  FUNNEL_KINDS,
  FUNNEL_STEPS,
  type FunnelCounts,
  type FunnelKindCounts,
  type FunnelKindRates,
  type FunnelRow,
  type FunnelStep,
  type Rate,
} from './reportTypes';

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

export function emptyKinds(): FunnelKindCounts {
  return { group: { booked: 0, attended: 0 }, individual: { booked: 0, attended: 0 } };
}

/** Конверсии по видам: запись — к ЛПР, явка — к записи того же вида. */
export function kindRates(counts: FunnelCounts, kinds: FunnelKindCounts): FunnelKindRates {
  const out = {} as FunnelKindRates;
  for (const k of FUNNEL_KINDS) out[k] = { booked: rate(kinds[k].booked, counts.lpr), attended: rate(kinds[k].attended, kinds[k].booked) };
  return out;
}

export function funnelRow(key: string, name: string | null, counts: FunnelCounts, kinds: FunnelKindCounts = emptyKinds()): FunnelRow {
  return { key, name, counts, rates: funnelRates(counts), kinds, kindRates: kindRates(counts, kinds) };
}

/** Шаги по видам из строк репозитория → карта «ключ строки → счётчики видов». */
export function kindsByKey(rows: readonly FunnelKindStepRow[]): Map<string, FunnelKindCounts> {
  const by = new Map<string, FunnelKindCounts>();
  for (const r of rows) {
    const c = by.get(r.key) ?? emptyKinds();
    c[r.kind][r.step] += r.n;
    by.set(r.key, c);
  }
  return by;
}

export function addKinds(into: FunnelKindCounts, add: FunnelKindCounts): void {
  for (const k of FUNNEL_KINDS) {
    into[k].booked += add[k].booked;
    into[k].attended += add[k].attended;
  }
}

/** Из счётчиков оператора: записи = группы + консультации. */
export function funnelOf(c: Counts): FunnelCounts {
  return { issued: c.issued, connected: c.connects, lpr: c.lpr, booked: c.groups + c.consults, attended: c.attended, purchased: c.purchases };
}

export function addFunnel(into: FunnelCounts, add: FunnelCounts): void {
  for (const s of FUNNEL_STEPS) into[s] += add[s];
}

/** Строки по источникам из шагов репозитория; порядок — по числу выданных, затем по ключу. */
export function funnelBySourceRows(rows: readonly SourceStepRow[], kinds: ReadonlyMap<string, FunnelKindCounts> = new Map()): { rows: FunnelRow[]; total: FunnelRow } {
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
    .map(([key, c]) => funnelRow(key, null, c, kinds.get(key)));
  const totalKinds = emptyKinds();
  for (const k of kinds.values()) addKinds(totalKinds, k);
  return { rows: list, total: funnelRow('', null, total, totalKinds) };
}
