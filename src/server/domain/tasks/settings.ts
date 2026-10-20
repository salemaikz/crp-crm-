// Настройки задач пространства: `tasks.askNextStep`, рабочий календарь (предупреждение о нерабочем сроке) и роли
// для списка исполнителей (D-253). Свой Zod поверх активных настроек: набор уже проверен целиком, здесь берётся
// только нужный срез (как distribution/settings.ts).
import { time } from '@crm/core';
import { z } from 'zod';
import { getActiveConfig } from '@/server/platform/config/active';

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Weekday = z.number().int().min(1).max(7);
const Window = z.object({ start: Hhmm, end: Hhmm }).passthrough();

const Role = z
  .object({
    key: z.string().min(1),
    archived: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    grants: z.array(z.object({ perm: z.string(), scope: z.string() }).passthrough()).optional(),
    relations: z.array(z.object({ key: z.string(), params: z.record(z.unknown()).optional() }).passthrough()).optional(),
  })
  .passthrough();

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
    roles: z.array(Role),
  })
  .passthrough();

const SpaceSlice = z.object({ tasks: z.object({ askNextStep: z.record(z.boolean()) }).passthrough() }).passthrough();

/** Окно консультанта роли (отношение `booked_with_me`): дни относительно даты записи, включительно. */
export type ConsultantRole = { key: string; window: { fromDays: number; toDays: number } };

export interface TasksConfig {
  timeZone: string;
  calendar: time.WorkCalendar;
  /** `tasks.askNextStep`: роль → предлагать «Создать следующую?» после «Готово». */
  askNextStep: Readonly<Record<string, boolean>>;
  /** Роли, видящие задачи пространства (`task.read` охвата space/all, не «только чтение»): им можно назначать. */
  staffRoles: readonly string[];
  /** Роли с окном консультанта: исполнитель — если у клиента его живая индивидуальная запись в окне. */
  consultantRoles: readonly ConsultantRole[];
}

const WIDE = new Set(['space', 'all']);

function windowOf(params: Record<string, unknown> | undefined): { fromDays: number; toDays: number } | null {
  const from = params?.fromDays;
  const to = params?.toDays;
  return Number.isInteger(from) && Number.isInteger(to) ? { fromDays: from as number, toDays: to as number } : null;
}

/** Чистый разбор: документ global и документ пространства → настройки задач. Ошибка схемы — исключение. */
export function parseTasksConfig(input: { global: unknown; space: unknown }): TasksConfig {
  const g = GlobalSlice.parse(input.global);
  const s = SpaceSlice.parse(input.space);
  const cal = g.calendar;
  const calendar = time.createWorkCalendar({
    timezone: g.org.timezone,
    workdays: cal.workdays,
    workHours: { start: cal.workHours.start, end: cal.workHours.end },
    callWindow: { start: cal.callWindow.start, end: cal.callWindow.end },
    holidays: cal.holidays.map((h) => ({ date: h.date, kind: h.kind, ...(h.note !== undefined ? { note: h.note } : {}) })),
  });
  const live = g.roles.filter((r) => !r.archived);
  const staffRoles = live
    .filter((r) => !r.readOnly && (r.grants ?? []).some((x) => x.perm === 'task.read' && WIDE.has(x.scope)))
    .map((r) => r.key);
  const consultantRoles: ConsultantRole[] = [];
  for (const r of live) {
    if (r.readOnly) continue;
    const rel = (r.relations ?? []).find((x) => x.key === 'booked_with_me');
    const w = rel ? windowOf(rel.params) : null;
    if (w && !staffRoles.includes(r.key)) consultantRoles.push({ key: r.key, window: w });
  }
  return { timeZone: g.org.timezone, calendar, askNextStep: s.tasks.askNextStep, staffRoles, consultantRoles };
}

// Разобранные настройки живут, пока жив объект активных настроек (кэш процесса меняет его при новой ревизии).
const cache = new WeakMap<object, Map<string, TasksConfig>>();

export async function loadTasksConfig(spaceId: string): Promise<TasksConfig> {
  const cfg = await getActiveConfig();
  let bySpace = cache.get(cfg);
  if (!bySpace) {
    bySpace = new Map();
    cache.set(cfg, bySpace);
  }
  const hit = bySpace.get(spaceId);
  if (hit) return hit;
  const space = Object.values(cfg.spaces).find((x) => x.spaceId === spaceId);
  if (!space) throw new Error('tasks: пространство не найдено в настройках');
  const parsed = parseTasksConfig({ global: cfg.global.doc, space: space.doc });
  bySpace.set(spaceId, parsed);
  return parsed;
}
