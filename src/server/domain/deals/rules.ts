// Чистые правила сделок (B6, docs/deals-handoffs-design.md §5): этапы, сумма, момент покупки, «залежалась».
// Без БД и часов: `now` приходит параметром.
import { time } from '@crm/core';
import type { DealPipelineInfo, DealStageInfo, StaleDaysOf } from './types';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Самая ранняя дата покупки: не раньше «сейчас − 400 дней». */
export const PURCHASE_PAST_LIMIT_DAYS = 400;
/** Потолок суммы, целые тенге (как Zod маршрута). */
export const AMOUNT_MAX_KZT = 1e12;
/** Покупка, зарегистрированная днём, — 12:00 местного времени этого дня. */
export const PURCHASE_DAY_TIME = '12:00';

/**
 * Сколько календарных дней открытая сделка лежит на этапе (D-244), если это не меньше `staleDays` этапа; иначе null.
 * Не открытая сделка и этап без `staleDays` — null.
 */
export const staleDaysOf: StaleDaysOf = (deal, stage, now) => {
  if (deal.status !== 'open' || !stage || stage.staleDays === null) return null;
  const days = Math.floor((now - deal.stageChangedAt) / DAY_MS);
  return days >= stage.staleDays ? days : null;
};

/** Этап «Покупка» воронки (первый `won` по порядку); нет — null (ошибка настроек). */
export function wonStageOf(p: Pick<DealPipelineInfo, 'stages'>): DealStageInfo | null {
  return p.stages.find((s) => s.kind === 'won') ?? null;
}

/** Этап «Проигран» воронки (первый `lost` по порядку); нет — null. */
export function lostStageOf(p: Pick<DealPipelineInfo, 'stages'>): DealStageInfo | null {
  return p.stages.find((s) => s.kind === 'lost') ?? null;
}

/** Вперёд ли переход: `order` цели больше текущего. Неизвестный текущий этап (архивный) — вперёд. */
export function isForward(p: Pick<DealPipelineInfo, 'stages'>, fromKey: string, toKey: string): boolean {
  const from = p.stages.find((s) => s.key === fromKey);
  const to = p.stages.find((s) => s.key === toKey);
  if (!to) return false;
  if (!from) return true;
  return to.order > from.order;
}

/** Требования этапа, которые проверяются при ручном переносе (PROCESS 4.2). */
export interface StageRequires {
  nextTask: boolean;
  fields: string[];
  booking: boolean;
  attendance: boolean;
}

/**
 * Что проверить при ручном переносе на этап (PROCESS 4.2): шаг с датой, поля, запись, явка. Этап без `requires`
 * (так его отдаёт настройка без требований) — без требований, как `Requires` по умолчанию в settings.ts.
 */
export function stageRequirements(stage: { requires?: Partial<Pick<DealStageInfo['requires'], keyof StageRequires>> | undefined }): StageRequires {
  const r = stage.requires ?? {};
  return { nextTask: r.nextTask ?? false, fields: [...(r.fields ?? [])], booking: r.booking ?? false, attendance: r.attendance ?? false };
}

/** Сумма — целое число тенге от 0 до 1e12 (строка и дробь — нет). */
export function checkAmount(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= AMOUNT_MAX_KZT;
}

/**
 * Момент покупки: день → 12:00 местного времени; null-день — `now`. Не позже `now + limitH` часов и не раньше
 * `now − 400 дней`, иначе null (`won_at_invalid`). Неверный формат дня — тоже null.
 */
export function purchaseMoment(wonDay: string | null, tz: string, now: number, limitH: number): number | null {
  if (wonDay === null) return now;
  if (!time.isValidDay(wonDay)) return null;
  let at: number;
  try {
    at = time.fromLocalTime(wonDay, PURCHASE_DAY_TIME, tz);
  } catch {
    return null;
  }
  if (at > now + limitH * HOUR_MS) return null;
  if (at < now - PURCHASE_PAST_LIMIT_DAYS * DAY_MS) return null;
  return at;
}

/** Пустое ли значение поля для требования этапа (`deals.custom`). */
export function isEmptyFieldValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
