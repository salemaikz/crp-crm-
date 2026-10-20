// Общие помощники машины состояний карточки: эффекты, версия, шаги сроков, закрытие.
// Чистые функции: время и календарь приходят параметрами.

import type {
  AppliedResult,
  BookingEffect,
  CallingSettings,
  CardSnapshot,
  CardState,
  DealEffect,
  Effects,
  HHMM,
  Ms,
  PhoneSnapshot,
  Recipient,
  RejectCode,
  RejectedResult,
  StateCause,
  TaskEffect,
  TimelineEffect,
  UserId,
  WorkCalendar,
} from './spec/types.js';
import { CALLBACK_TASK_SOURCES } from './spec/types.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Закрытые состояния: переход в них закрывает все задачи клиента. */
export const CLOSED_STATES: readonly CardState[] = ['not_interested', 'not_target', 'do_not_call', 'written_off'];

export function emptyEffects(): Effects {
  return {
    tasks: [],
    deals: [],
    bookings: [],
    stopList: [],
    assignLog: [],
    notifications: [],
    timeline: [],
    audit: [],
    skips: [],
  };
}

export function reject(error: RejectCode, field: string | null = null): RejectedResult {
  return { status: 'rejected', error, field };
}

export function applied(card: CardSnapshot, effects: Effects = emptyEffects()): AppliedResult {
  return { status: 'applied', card, call: null, effects, warnings: [] };
}

// ---------- Версия карточки ----------

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Применяет изменения к карточке. `version + 1`, только если изменилось хоть одно
 * поле; иначе карточка возвращается как была (та же версия).
 */
export function commit(before: CardSnapshot, patch: Partial<CardSnapshot>): CardSnapshot {
  const next: CardSnapshot = { ...before, ...patch, version: before.version };
  const keys = Object.keys(next) as (keyof CardSnapshot)[];
  const changed = keys.some((k) => !sameValue(before[k], next[k]));
  return changed ? { ...next, version: before.version + 1 } : before;
}

// ---------- Сроки ----------

const SHIFT_RE = /^\+(\d+)([hm])$/;
const WORKDAY_RE = /^nextWorkday@(\d{2}:\d{2})$/;

/** Шаг срока: `+Nh`, `+Nm` (сдвиг) или `nextWorkday@HH:MM`. */
export function stepAt(step: string, from: Ms, calendar: WorkCalendar): Ms {
  const shift = SHIFT_RE.exec(step);
  if (shift) return from + Number(shift[1]) * (shift[2] === 'h' ? HOUR_MS : MINUTE_MS);
  const wd = WORKDAY_RE.exec(step);
  if (wd && wd[1]) return calendar.nextWorkdayAt(from, wd[1]);
  throw new Error(`unknown step: ${step}`);
}

/** Срок шага повтора: сдвиг вне окна звонков переносится на ближайшее рабочее время (PROCESS 3.4). */
export function retryStepAt(step: string, from: Ms, settings: CallingSettings, calendar: WorkCalendar): Ms {
  const t = stepAt(step, from, calendar);
  if (!SHIFT_RE.test(step) || calendar.isInCallWindow(t)) return t;
  const hhmm: HHMM = settings.retry.steps.map((s) => WORKDAY_RE.exec(s)?.[1]).find(Boolean) ?? calendar.callWindowStart;
  return calendar.nextWorkdayTimeAfter(t, hhmm);
}

// ---------- Получатели и задачи ----------

/** Владелец карточки; без владельца задачи уходят руководителю. */
export function ownerRecipient(card: CardSnapshot): Recipient {
  return card.ownerUserId !== null ? { user: card.ownerUserId } : { role: 'lead' };
}

export function callbackTask(card: CardSnapshot, opId: string, dueAt: Ms): TaskEffect {
  return { op: 'create', source: 'callback', kind: 'call', assignee: ownerRecipient(card), dueAt, sourceKey: `callback:${opId}` };
}

export const closeCallbackTasks = (): TaskEffect => ({ op: 'close', sources: [...CALLBACK_TASK_SOURCES] });
export const closeAllTasks = (): TaskEffect => ({ op: 'close', sources: 'all' });

/** Закрытие задач при выходе из состояния: в закрытое — все, из `callback` — проекция перезвона. */
export function leaveTasks(from: CardState, to: CardState): TaskEffect[] {
  if (CLOSED_STATES.includes(to)) return [closeAllTasks()];
  // Выход из `callback` и перенос перезвона (`callback → callback`): старую проекцию закрыть.
  if (from === 'callback') return [closeCallbackTasks()];
  return [];
}

// ---------- Лента ----------

export function tlState(t: Ms, actorId: UserId | null, from: CardState, to: CardState, cause: StateCause): TimelineEffect {
  return { kind: 'card.state', at: t, actorId, ref: null, data: { fromState: from, toState: to, cause } };
}

// ---------- Закрытие карточки ----------

export type CloseKind = 'not_interested' | 'not_target' | 'do_not_call';

/** Эффекты перехода в закрытое состояние (общие для итога, меню, слияния). */
export function closeEffects(kind: CloseKind | 'written_off', reasonCode: string): Pick<Effects, 'tasks' | 'deals' | 'bookings'> {
  const deals: DealEffect[] = [];
  const bookings: BookingEffect[] = [];
  if (kind !== 'written_off') deals.push({ op: 'lose_open', reasonGroup: kind, reasonCode });
  if (kind === 'not_target' || kind === 'do_not_call') bookings.push({ op: 'cancel_future', reason: kind });
  return { tasks: [closeAllTasks()], deals, bookings };
}

export interface DncPlan {
  /** Номера, помечаемые `inStopList`. */
  add: string[];
  /** Общие с другим клиентом номера: ждут подтверждения руководителя. */
  review: string[];
}

/** Какие из номеров идут в стоп-лист, а какие — на подтверждение (порядок сохраняется, повторы убираются). */
export function planDnc(phones: PhoneSnapshot[], ids: string[]): DncPlan {
  const plan: DncPlan = { add: [], review: [] };
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = phones.find((x) => x.id === id);
    if (!p) continue;
    if (p.sharedWithOtherClient) plan.review.push(id);
    else if (!p.inStopList) plan.add.push(id);
  }
  return plan;
}

/** Эффекты стоп-листа и подтверждения для плана, плюс новые номера карточки. */
export function dncEffects(
  plan: DncPlan,
  phones: PhoneSnapshot[],
  opId: string,
  reasonCode: string,
): { stopList: Effects['stopList']; reviewTasks: TaskEffect[]; phones: PhoneSnapshot[] } {
  return {
    stopList: plan.add.map((phoneId) => ({ op: 'add' as const, phoneId, reasonCode })),
    reviewTasks: plan.review.map((phoneId) => ({
      op: 'create' as const,
      source: 'review' as const,
      kind: 'check' as const,
      assignee: { role: 'lead' as const },
      dueAt: null,
      sourceKey: `dnc_confirm:${opId}:${phoneId}`,
    })),
    phones: phones.map((p) => (plan.add.includes(p.id) ? { ...p, inStopList: true } : p)),
  };
}

export function dncSetEvent(t: Ms, actorId: UserId | null, plan: DncPlan): TimelineEffect {
  return { kind: 'dnc.set', at: t, actorId, ref: null, data: { phonesAdded: plan.add.length, phonesToReview: plan.review.length } };
}
