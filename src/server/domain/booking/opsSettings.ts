// Срез настроек дежурства, сверок и гостя без записи (docs/deals-handoffs-design.md §2.1, CONFIG §6.9):
// то, чего нет в BookingSettings. Свой Zod поверх уже проверенного набора; разобранное живёт, пока жив
// объект активных настроек.
import { names, type phone, type time } from '@crm/core';
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';
import { BookingDomainError } from './errors';
import type { BookingOpsSettings, LoadBookingOpsSettings } from './consultTypes';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const GlobalSlice = z
  .object({
    security: z.object({ phoneProbesPerDay: z.number().int().min(0) }).passthrough(),
    phone: z.object({ country: z.literal('KZ') }).passthrough(),
    org: z.object({ legalForms: z.array(z.object({ key: z.string(), aliases: z.array(z.string()), idIsPersonal: z.boolean().optional() }).passthrough()) }).passthrough(),
    sources: z.array(z.object({ key: z.string(), kind: z.string(), archived: z.boolean().optional() }).passthrough()),
  })
  .passthrough();

const SpaceSlice = z
  .object({
    booking: z
      .object({
        grey: z.object({ mode: z.enum(['assign', 'suggest']), schedule: z.object({ first: Hhmm, last: Hhmm, stepMin: z.number().int().min(1) }).passthrough() }).passthrough(),
        duty: z.object({ defaultRole: z.string() }).passthrough(),
        attendance: z.object({ autoNoShowWorkdays: z.number().int().min(1).nullable() }).passthrough(),
        nextStep: z.object({ taskAt: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** Настройки гостя без записи: общий срез плюс правила номера, формы собственности и срок «следующего шага». */
export interface WalkInSettings extends BookingOpsSettings {
  phoneRules: phone.PhoneRules;
  legalForms: names.LegalForm[];
  /** `booking.nextStep.taskAt`: шаг срока задачи «Записать на следующий шаг». */
  nextStepTaskAt: string;
}

const cache = new WeakMap<object, Map<string, WalkInSettings>>();

/** Срок шага `+Nh`, `+Nm`, `nextWorkday@HH:MM` (тот же формат, что у `calling.retry`; ядро разборщик не отдаёт). */
export function resolveStepDue(step: string, from: number, calendar: time.WorkCalendar): number {
  const shift = /^\+([1-9]\d{0,3})([hm])$/.exec(step);
  if (shift) return from + Number(shift[1]) * (shift[2] === 'h' ? 3_600_000 : 60_000);
  const day = /^nextWorkday@(([01]\d|2[0-3]):[0-5]\d)$/.exec(step);
  if (day) return calendar.nextWorkdayAt(from, day[1] as string);
  throw new BookingDomainError('invalid_settings');
}

/** Чистый разбор: документ global и документ пространства → срез настроек. Ошибка схемы → `invalid_settings`. */
export function parseWalkInSettings(input: { spaceId: string; global: unknown; space: unknown }): WalkInSettings {
  const g = GlobalSlice.safeParse(input.global);
  const s = SpaceSlice.safeParse(input.space);
  if (!g.success || !s.success) throw new BookingDomainError('invalid_settings');
  const b = s.data.booking;
  return {
    spaceId: input.spaceId,
    grey: { mode: b.grey.mode, schedule: { first: b.grey.schedule.first, last: b.grey.schedule.last, stepMin: b.grey.schedule.stepMin } },
    dutyDefaultRole: b.duty.defaultRole,
    autoNoShowWorkdays: b.attendance.autoNoShowWorkdays,
    phoneProbesPerDay: g.data.security.phoneProbesPerDay,
    walkInSourceKey: g.data.sources.find((x) => x.kind === 'walk_in' && x.archived !== true)?.key ?? null,
    phoneRules: g.data.phone as unknown as phone.PhoneRules,
    legalForms: names.legalFormsFromConfig(g.data.org.legalForms),
    nextStepTaskAt: b.nextStep.taskAt,
  };
}

export async function loadWalkInSettings(spaceId: string): Promise<WalkInSettings> {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === spaceId);
  if (!space) throw new BookingDomainError('invalid_settings');
  const out = parseWalkInSettings({ spaceId, global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, out);
  return out;
}

export const loadBookingOpsSettings: LoadBookingOpsSettings = async (spaceId) => loadWalkInSettings(spaceId);
