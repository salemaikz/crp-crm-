// Настройки обзвона пространства: `calling.*`, `queue.*`, `distribution.capIncludes`, `booking.noShow/nextStep/
// attendance`, `tasks.*`, календарь и пояс (CONFIG §6.1–6.2, §6.5, §6.6, §6.9, §6.12). Свой Zod поверх активных
// настроек: набор уже проверен целиком, здесь берётся только нужный срез (как booking/settings.ts).
import { time } from '@crm/core';
import { z } from 'zod';
import { CallsDomainError } from '@/server/domain/calls/errors';
import { getActiveConfig } from '@/server/platform/config/active';
import { getDb } from '@/server/platform/db';
import { archivedAtOfOutcomes } from './repo';
import { QUEUE_GROUPS, type CallingContext, type LoadCallingContext, type OutcomeConfig } from './types';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Weekday = z.number().int().min(1).max(7);
const Window = z.object({ start: Hhmm, end: Hhmm }).passthrough();
const Step = z.string().min(1);

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

const Outcome = z
  .object({
    key: z.string().min(1),
    kind: z.enum(['no_answer', 'bad_number', 'callback', 'agreed', 'not_interested', 'not_target', 'do_not_call']),
    order: z.number().int(),
    requires: z
      .object({
        lpr: z.boolean(),
        reason: z.boolean(),
        callbackAt: z.boolean(),
        contact: z.boolean(),
        agreement: z.boolean(),
        fields: z.array(z.string()),
      })
      .passthrough(),
    archived: z.boolean().optional(),
  })
  .passthrough();

const SpaceSlice = z
  .object({
    calling: z
      .object({
        outcomes: z.array(Outcome).min(1),
        lprRequiredOnContact: z.boolean(),
        lprNoRequiresInfo: z.boolean(),
        offlineWindowHours: z.number().int().min(1),
        callbackPastToleranceMin: z.number().int().min(0),
        retry: z.object({ steps: z.array(Step), maxAttempts: z.number().int().min(1) }).passthrough(),
        returnDays: z.object({ not_interested: z.number().int().nullable(), deal_lost_soft: z.number().int().nullable() }).passthrough(),
      })
      .passthrough(),
    queue: z.object({ order: z.array(z.enum(QUEUE_GROUPS)).length(QUEUE_GROUPS.length), mobileFirst: z.boolean(), skipLimit: z.number().int().min(0) }).passthrough(),
    distribution: z.object({ capIncludes: z.array(z.enum(['auto', 'manual', 'return', 'inbound', 'proposal'])) }).passthrough(),
    booking: z
      .object({
        noShow: z.object({ callbackAt: Step }).passthrough(),
        nextStep: z.object({ taskAt: Step }).passthrough(),
        attendance: z.object({ autoNoShowWorkdays: z.number().int().min(1).nullable() }).passthrough(),
      })
      .passthrough(),
    tasks: z.object({ overdueAlertMinutes: z.number().int().min(1), inboundReplyMinutes: z.number().int().min(1) }).passthrough(),
  })
  .passthrough();

export interface ParseCallingInput {
  spaceId: string;
  /** Ревизия документа пространства: calls.config_rev. */
  rev: number;
  global: unknown;
  space: unknown;
  /** Когда ревизия архивировала итог (по ключу); нет записи — null. Читает `loadCallingContext`. */
  archivedAt?: ReadonlyMap<string, number>;
}

/** Чистый разбор: документы global и пространства → настройки обзвона. Ошибка схемы → `invalid_settings`. */
export function parseCallingContext(input: ParseCallingInput): CallingContext {
  const g = GlobalSlice.safeParse(input.global);
  const s = SpaceSlice.safeParse(input.space);
  if (!g.success || !s.success) throw new CallsDomainError('invalid_settings');
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
    throw new CallsDomainError('invalid_settings');
  }
  const c = s.data.calling;
  const outcomes: OutcomeConfig[] = [...c.outcomes]
    .sort((a, b) => a.order - b.order)
    .map((o) => ({
      key: o.key,
      kind: o.kind,
      requires: { lpr: o.requires.lpr, reason: o.requires.reason, callbackAt: o.requires.callbackAt, contact: o.requires.contact, agreement: o.requires.agreement },
      archived: o.archived === true,
      archivedAt: o.archived === true ? (input.archivedAt?.get(o.key) ?? null) : null,
      requiredFields: o.requires.fields,
    }));
  const b = s.data.booking;
  return {
    spaceId: input.spaceId,
    configRev: input.rev,
    settings: {
      outcomes: outcomes.map((o) => ({ key: o.key, kind: o.kind, requires: o.requires, archived: o.archived, archivedAt: o.archivedAt })),
      lprRequiredOnContact: c.lprRequiredOnContact,
      lprNoRequiresInfo: c.lprNoRequiresInfo,
      callbackPastToleranceMin: c.callbackPastToleranceMin,
      offlineWindowHours: c.offlineWindowHours,
      retry: { steps: c.retry.steps, maxAttempts: c.retry.maxAttempts },
      returnDays: { not_interested: c.returnDays.not_interested, deal_lost_soft: c.returnDays.deal_lost_soft },
      skipLimit: s.data.queue.skipLimit,
      capIncludes: s.data.distribution.capIncludes,
      noShowCallbackAt: b.noShow.callbackAt,
      nextStepTaskAt: b.nextStep.taskAt,
      autoNoShowWorkdays: b.attendance.autoNoShowWorkdays,
      inboundReplyMinutes: s.data.tasks.inboundReplyMinutes,
    },
    calendar,
    outcomes,
    queue: { order: s.data.queue.order, mobileFirst: s.data.queue.mobileFirst, skipLimit: s.data.queue.skipLimit },
    overdueAlertMinutes: s.data.tasks.overdueAlertMinutes,
  };
}

// Разобранные настройки живут, пока жив объект активных настроек (кэш процесса меняет его при новой ревизии).
const cache = new WeakMap<object, Map<string, CallingContext>>();

export const loadCallingContext: LoadCallingContext = async (spaceId) => {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((x) => x.spaceId === spaceId);
  if (!space) throw new CallsDomainError('invalid_settings');
  // Архивные итоги: время ревизии, которая их архивировала (окно приёма офлайн-итога, PROCESS 12.31).
  const archivedKeys = ((space.doc as unknown as { calling?: { outcomes?: Array<{ key: string; archived?: boolean }> } }).calling?.outcomes ?? [])
    .filter((o) => o.archived === true)
    .map((o) => o.key);
  const archivedAt = archivedKeys.length > 0 ? await archivedAtOfOutcomes((await getDb()).sql, spaceId, archivedKeys) : new Map<string, number>();
  const parsed = parseCallingContext({ spaceId, rev: space.rev, global: cfg.global.doc, space: space.doc, archivedAt });
  bySpace.set(spaceId, parsed);
  return parsed;
};
