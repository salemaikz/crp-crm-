// Горячесть карточки перезвона и эталонный порядок очереди (pipeline-v2 §6.1).
// Чистые функции: ни БД, ни Date.now(). Веса приходят из настроек (`queue.heat`), своих чисел у ядра нет.

import { fireOf } from './due.js';
import type { DueBounds } from './due.js';
import type { CallbackPrecision, CardState, Lpr, Ms } from './spec/types.js';

/** Верхняя граница горячести. Каждый вес в схеме не больше 10000, поэтому сумма не выходит за колонку. */
export const HEAT_MAX = 100_000;

export interface HeatWeights {
  /** Вес состояния (пример: перезвон 100, новая 20, недозвон 0). */
  states: Partial<Record<CardState, number>>;
  /** Вес по ключу причины перезвона. */
  reasons: Record<string, number>;
  flags: { attendedGroup: number; attendedIndividual: number; noShow: number; purchased: number; lprYes: number };
}

export interface HeatCard {
  state: CardState;
  callbackReason: string;
  lpr: Lpr;
  attendedGroupAt: Ms | null;
  attendedIndividualAt: Ms | null;
  lastNoShowAt: Ms | null;
  purchasesTotal: number;
  nextCallAt: Ms | null;
  nextCallPrecision: CallbackPrecision;
}

/** Состояния, у которых есть горячесть: рабочие. Закрытые, `agreed` и `client` сортируются по своим правилам. */
const HEAT_STATES: readonly CardState[] = ['new', 'retry', 'callback'];

/** Вес как целое неотрицательное число: мусор из настроек не должен ломать сортировку. */
function w(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Неявка считается, если она позже последней явки (после явки неявка старой записи не греет). */
function noShowCounts(c: HeatCard): boolean {
  if (c.lastNoShowAt === null) return false;
  const lastAttended = Math.max(c.attendedGroupAt ?? -Infinity, c.attendedIndividualAt ?? -Infinity);
  return c.lastNoShowAt > lastAttended;
}

/** Постоянная часть горячести (хранится в `cards.heat`), зажата в `0..HEAT_MAX`. */
export function heatOf(c: HeatCard, weights: HeatWeights): number {
  if (!HEAT_STATES.includes(c.state)) return 0;
  let sum = w(weights.states[c.state]);
  if (c.state !== 'new' && c.callbackReason !== '') sum += w(weights.reasons[c.callbackReason]);
  const f = weights.flags;
  if (c.attendedGroupAt !== null) sum += w(f.attendedGroup);
  if (c.attendedIndividualAt !== null) sum += w(f.attendedIndividual);
  if (noShowCounts(c)) sum += w(f.noShow);
  if (c.purchasesTotal > 0) sum += w(f.purchased);
  if (c.lpr === 'yes') sum += w(f.lprYes);
  return Math.min(HEAT_MAX, Math.max(0, Math.round(sum)));
}

/** Что нужно порядку очереди от карточки: хранимая горячесть и срок. */
export interface QueueKey {
  id: string;
  heat: number;
  nextCallAt: Ms | null;
  nextCallPrecision: CallbackPrecision;
}

const FIRE_RANK = { overdue: 0, today: 0, none: 1 } as const;

/**
 * Эталон порядка колонки «Перезвон» и очереди: огонёк (просрочен или на сегодня) → `heat` ↓ →
 * `next_call_at` ↑ (без срока в конце, как `NULLS LAST`) → `id`. Отрицательное число — `a` раньше `b`.
 */
export function compareForQueue(a: QueueKey, b: QueueKey, bounds: DueBounds): number {
  const fa = FIRE_RANK[fireOf(a.nextCallAt, a.nextCallPrecision, bounds) ?? 'none'];
  const fb = FIRE_RANK[fireOf(b.nextCallAt, b.nextCallPrecision, bounds) ?? 'none'];
  if (fa !== fb) return fa - fb;
  if (a.heat !== b.heat) return b.heat - a.heat;
  if (a.nextCallAt !== b.nextCallAt) {
    if (a.nextCallAt === null) return 1;
    if (b.nextCallAt === null) return -1;
    return a.nextCallAt - b.nextCallAt;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
