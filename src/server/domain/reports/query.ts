// Разбор параметров отчёта (строка запроса API и адрес страницы): Zod `.strict()`, лишние ключи — 400.
// Период по умолчанию — текущая неделя; его даёт вызывающий (нужен пояс установки).
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import type { Grouping, PeriodInput, ReportFilters, ReportKey, ReportQuery } from './reportTypes';

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Common = {
  from: Day.optional(),
  to: Day.optional(),
  users: z.string().max(4000).optional(),
  source: z.string().min(1).max(64).optional(),
};

const Schemas = {
  operators: z.object({ ...Common, group: z.enum(['total', 'day', 'week']).optional() }).strict(),
  funnel: z.object({ ...Common, by: z.enum(['operator', 'source']).optional() }).strict(),
  revenue: z.object(Common).strict(),
  attendance: z.object({ ...Common, by: z.enum(['event_type', 'consultant', 'author']).optional() }).strict(),
  reasons: z.object(Common).strict(),
} as const;

export const MAX_FILTER_USERS = 50;

function parseUsers(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
  if (ids.length === 0) return null;
  if (ids.length > MAX_FILTER_USERS || ids.some((id) => id.length > 64)) throw new BadRequestError('invalid');
  return ids;
}

/** Параметры → запрос отчёта. Пустые значения считаются отсутствующими. */
export function parseReportQuery(key: ReportKey, params: Readonly<Record<string, string | undefined>>, defaults: PeriodInput): ReportQuery {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') clean[k] = v;
  const p = Schemas[key].parse(clean) as { from?: string; to?: string; users?: string; source?: string; group?: Grouping; by?: string };
  const period: PeriodInput = { from: p.from ?? defaults.from, to: p.to ?? defaults.to };
  const filters: ReportFilters = { userIds: parseUsers(p.users), sourceKey: p.source ?? null };
  switch (key) {
    case 'operators':
      return { key, period, filters, grouping: p.group ?? 'total' };
    case 'funnel':
      return { key, period, filters, by: (p.by as 'operator' | 'source' | undefined) ?? 'operator' };
    case 'attendance':
      return { key, period, filters, by: (p.by as 'event_type' | 'consultant' | 'author' | undefined) ?? 'event_type' };
    case 'revenue':
      return { key, period, filters };
    case 'reasons':
      return { key, period, filters };
  }
}
