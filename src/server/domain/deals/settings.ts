// Настройки сделок пространства (B6, docs/deals-handoffs-design.md §5.1): воронки целиком, типы услуг, причины
// проигрыша, срок даты покупки, срок принятия передачи, календарь и пояс (CONFIG §6.1–6.2, §6.8).
// Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся только нужный срез.
import { time } from '@crm/core';
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import { DealDomainError } from './errors';
import type { DealPipelineInfo, DealsSettings, LoadDealsSettings } from './types';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Weekday = z.number().int().min(1).max(7);
const Window = z.object({ start: Hhmm, end: Hhmm }).passthrough();
const Label = z.object({ ru: z.string(), kk: z.string().optional() }).passthrough();

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

const Requires = z
  .object({
    fields: z.array(z.string()).default([]),
    booking: z.boolean().default(false),
    attendance: z.boolean().default(false),
    nextTask: z.boolean().default(false),
    amount: z.boolean().default(false),
    serviceType: z.boolean().default(false),
    reason: z.boolean().default(false),
  })
  .passthrough();

const Stage = z
  .object({
    key: z.string().min(1),
    label: Label.optional(),
    kind: z.enum(['open', 'won', 'lost']),
    order: z.number().int(),
    requires: Requires.optional(),
    staleDays: z.number().int().positive().nullable().optional(),
    auto: z.enum(['on_agreed', 'on_attended']).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const Pipeline = z
  .object({
    key: z.string().min(1),
    label: Label.optional(),
    createDealOn: z.enum(['agreed', 'client_created', 'manual']),
    stages: z.array(Stage),
    archived: z.boolean().optional(),
  })
  .passthrough();

const Reason = z
  .object({ key: z.string().min(1), label: Label.optional(), softness: z.enum(['soft', 'hard']), needsText: z.boolean(), archived: z.boolean().optional() })
  .passthrough();

const SpaceSlice = z
  .object({
    pipelines: z.array(Pipeline),
    serviceTypes: z.array(z.object({ key: z.string().min(1), label: Label.optional(), routeToTeam: z.string().nullable().optional(), archived: z.boolean().optional() }).passthrough()),
    reasons: z.record(z.string(), z.array(Reason)).optional(),
    deals: z.object({ purchaseFutureLimitHours: z.number().int().min(0) }).passthrough(),
    handoff: z.object({ acceptSlaWorkdays: z.number().int().min(1) }).passthrough(),
  })
  .passthrough();

type L = { ru: string; kk?: string | undefined } | undefined;
const label = (l: L, fallback: string): { ru: string; kk?: string } => (l ? { ru: l.ru, ...(l.kk !== undefined ? { kk: l.kk } : {}) } : { ru: fallback });

function toPipelines(raw: z.infer<typeof Pipeline>[]): DealPipelineInfo[] {
  return raw
    .filter((p) => !p.archived)
    .map((p) => ({
      key: p.key,
      label: label(p.label, p.key),
      createDealOn: p.createDealOn,
      stages: p.stages
        .filter((s) => !s.archived)
        .map((s) => {
          const r = s.requires ?? Requires.parse({});
          return {
            key: s.key,
            label: label(s.label, s.key),
            kind: s.kind,
            order: s.order,
            requires: { fields: r.fields, booking: r.booking, attendance: r.attendance, nextTask: r.nextTask, amount: r.amount, serviceType: r.serviceType, reason: r.reason },
            staleDays: s.staleDays ?? null,
            auto: s.auto ?? null,
          };
        })
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    }));
}

/** Чистый разбор: документ global и документ пространства → настройки сделок. Ошибка схемы → `invalid_settings`. */
export function parseDealsSettings(input: { spaceId: string; global: unknown; space: unknown }): DealsSettings {
  const g = GlobalSlice.safeParse(input.global);
  const s = SpaceSlice.safeParse(input.space);
  if (!g.success || !s.success) throw new DealDomainError('invalid_settings');
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
    throw new DealDomainError('invalid_settings');
  }
  const sp = s.data;
  return {
    spaceId: input.spaceId,
    timeZone: g.data.org.timezone,
    calendar,
    workHoursEnd: cal.workHours.end,
    pipelines: toPipelines(sp.pipelines),
    serviceTypes: sp.serviceTypes.filter((t) => !t.archived).map((t) => ({ key: t.key, label: label(t.label, t.key), routeToTeam: t.routeToTeam ?? null })),
    lostReasons: (sp.reasons?.['deal_lost'] ?? [])
      .filter((r) => !r.archived)
      .map((r) => ({ key: r.key, label: label(r.label, r.key), softness: r.softness, needsText: r.needsText })),
    purchaseFutureLimitHours: sp.deals.purchaseFutureLimitHours,
    acceptSlaWorkdays: sp.handoff.acceptSlaWorkdays,
  };
}

// Разобранные настройки живут, пока жив объект активных настроек (кэш процесса меняет его при новой ревизии).
const cache = new WeakMap<object, Map<string, DealsSettings>>();

export const loadDealsSettings: LoadDealsSettings = async (spaceId) => {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((x) => x.spaceId === spaceId);
  if (!space) throw new DealDomainError('invalid_settings');
  const parsed = parseDealsSettings({ spaceId, global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, parsed);
  return parsed;
};
