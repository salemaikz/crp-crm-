// Настройки записи пространства: `booking.*`, воронки (этапы `auto`), календарь и пояс (CONFIG §6.8, §6.9, §6.1–6.2).
// Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся только нужный срез.
import { time } from '@crm/core';
import { z } from 'zod';
import { bookingPipeline, parsePipelines, toDealStages } from '@/server/domain/deals/pipelines';
import { getActiveConfig } from '@/server/platform/config/active';
import { BookingDomainError } from './errors';
import { EVENT_FORMATS, type BookingSettings, type LoadBookingSettings } from './types';

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

const EventType = z
  .object({
    key: z.string().min(1),
    behavior: z.enum(['group', 'individual']),
    capacity: z.number().int().positive().nullable(),
    durationMin: z.number().int().positive(),
  })
  .passthrough();

const SeedSeries = z
  .object({
    key: z.string().min(1),
    eventTypeKey: z.string().min(1),
    weekday: Weekday,
    startTime: Hhmm,
    durationMin: z.number().int().positive(),
    location: z.string(),
    format: z.enum(EVENT_FORMATS),
    capacity: z.number().int().positive(),
  })
  .passthrough();

const SpaceSlice = z
  .object({
    booking: z
      .object({
        eventTypes: z.array(EventType),
        horizonDays: z.number().int().min(1),
        groupOptions: z.number().int().min(1),
        seedSeries: z.array(SeedSeries),
      })
      .passthrough(),
    pipelines: z.array(z.unknown()),
  })
  .passthrough();

/** Окно отмены «ошибка оператора» автором, минуты (PROCESS 12.7) — константа продукта. */
export const OPERATOR_ERROR_WINDOW_MIN = 10;

/** Чистый разбор: документ global и документ пространства → настройки записи. Ошибка схемы → `invalid_settings`. */
export function parseBookingSettings(input: { spaceId: string; global: unknown; space: unknown }): BookingSettings {
  const g = GlobalSlice.safeParse(input.global);
  const s = SpaceSlice.safeParse(input.space);
  if (!g.success || !s.success) throw new BookingDomainError('invalid_settings');
  let pipelines;
  try {
    pipelines = parsePipelines(s.data.pipelines);
  } catch {
    throw new BookingDomainError('invalid_settings');
  }
  const cal = g.data.calendar;
  const tz = g.data.org.timezone;
  let calendar: time.WorkCalendar;
  try {
    calendar = time.createWorkCalendar({
      timezone: tz,
      workdays: cal.workdays,
      workHours: { start: cal.workHours.start, end: cal.workHours.end },
      callWindow: { start: cal.callWindow.start, end: cal.callWindow.end },
      holidays: cal.holidays.map((h) => ({ date: h.date, kind: h.kind, ...(h.note !== undefined ? { note: h.note } : {}) })),
    });
  } catch {
    throw new BookingDomainError('invalid_settings');
  }
  const b = s.data.booking;
  const pipeline = bookingPipeline(pipelines);
  return {
    spaceId: input.spaceId,
    timeZone: tz,
    calendar,
    groupTypes: b.eventTypes
      .filter((t) => t.behavior === 'group' && t.capacity !== null)
      .map((t) => ({ key: t.key, capacity: t.capacity as number, durationMin: t.durationMin })),
    horizonDays: b.horizonDays,
    groupOptions: b.groupOptions,
    seedSeries: b.seedSeries.map((x) => ({
      key: x.key,
      eventTypeKey: x.eventTypeKey,
      weekday: x.weekday,
      startTime: x.startTime,
      durationMin: x.durationMin,
      location: x.location,
      format: x.format,
      capacity: x.capacity,
    })),
    deals: pipeline ? toDealStages(pipeline) : null,
    operatorErrorWindowMin: OPERATOR_ERROR_WINDOW_MIN,
  };
}

// Разобранные настройки живут, пока жив объект активных настроек (кэш процесса меняет его при новой ревизии).
const cache = new WeakMap<object, Map<string, BookingSettings>>();

export const loadBookingSettings: LoadBookingSettings = async (spaceId) => {
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
  const parsed = parseBookingSettings({ spaceId, global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, parsed);
  return parsed;
};
