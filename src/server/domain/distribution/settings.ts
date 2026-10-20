// Настройки раздачи пространства: `distribution.*`, `queue.mobileFirst`, календарь и пояс (CONFIG §6.1–6.2, §6.6, §6.7).
// Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся только нужный срез.
import { distribution, time } from '@crm/core';
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import { DistributionDomainError } from './errors';
import type { DistributionConfig, LoadDistributionConfig } from './types';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Weekday = z.number().int().min(1).max(7);
const Window = z.object({ start: Hhmm, end: Hhmm }).passthrough();

const GlobalSlice = z
  .object({
    org: z.object({ timezone: z.string().min(1) }).passthrough(),
    calendar: z
      .object({
        workdays: z.array(Weekday).min(1),
        workHours: Window,
        callWindow: Window,
        holidays: z.array(z.object({ date: z.string(), kind: z.enum(['holiday', 'workday']), note: z.string().optional() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();

const ISSUE_KINDS = ['auto', 'manual', 'return', 'inbound', 'proposal'] as const;

const DistributionSlice = z
  .object({
    mode: z.enum(['auto_even', 'top_up', 'manual', 'off']),
    schedule: z.object({ from: Hhmm, to: Hhmm, everyMin: z.number().int().min(1), workdaysOnly: z.boolean() }).passthrough(),
    dailyCap: z.number().int().min(0),
    capIncludes: z.array(z.enum(ISSUE_KINDS)),
    capOverride: z.boolean(),
    topUpKeep: z.number().int().min(0),
    participantRoles: z.array(z.string().min(1)),
  })
  .passthrough();

const SpaceSlice = z
  .object({
    distribution: DistributionSlice,
    queue: z.object({ mobileFirst: z.boolean() }).passthrough(),
  })
  .passthrough();

/** Чистый разбор: документ global и документ пространства → настройки раздачи. Ошибка схемы → `invalid_settings`. */
export function parseDistributionConfig(input: { spaceId: string; global: unknown; space: unknown }): DistributionConfig {
  const g = GlobalSlice.safeParse(input.global);
  const s = SpaceSlice.safeParse(input.space);
  if (!g.success || !s.success) throw new DistributionDomainError('invalid_settings');
  const cal = g.data.calendar;
  let calendar: time.WorkCalendar;
  try {
    calendar = time.createWorkCalendar({
      timezone: g.data.org.timezone,
      workdays: cal.workdays,
      workHours: { start: cal.workHours.start, end: cal.workHours.end },
      callWindow: { start: cal.callWindow.start, end: cal.callWindow.end },
      holidays: cal.holidays.map((h) => ({ date: h.date, kind: h.kind, ...(h.note !== undefined ? { note: h.note } : {}) })),
    });
  } catch {
    throw new DistributionDomainError('invalid_settings');
  }
  const d = s.data.distribution;
  return {
    spaceId: input.spaceId,
    timeZone: g.data.org.timezone,
    settings: {
      mode: d.mode,
      schedule: { from: d.schedule.from, to: d.schedule.to, everyMin: d.schedule.everyMin, workdaysOnly: d.schedule.workdaysOnly },
      dailyCap: d.dailyCap,
      capIncludes: d.capIncludes,
      capOverride: d.capOverride,
      topUpKeep: d.topUpKeep,
    },
    participantRoles: d.participantRoles,
    mobileFirst: s.data.queue.mobileFirst,
    calendar: distribution.toDistributionCalendar(calendar),
  };
}

// Разобранные настройки живут, пока жив объект активных настроек (кэш процесса меняет его при новой ревизии).
const cache = new WeakMap<object, Map<string, DistributionConfig>>();

export const loadDistributionConfig: LoadDistributionConfig = async (spaceId) => {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  if (!space) throw new DistributionDomainError('invalid_settings');
  const parsed = parseDistributionConfig({ spaceId, global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, parsed);
  return parsed;
};
