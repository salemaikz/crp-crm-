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

/** Календарных суток между двумя моментами по часам пояса `tz`. */
function calendarDaysBetween(from: number, to: number, tz: string): number {
  const a = time.parseDay(time.localDayOf(from, tz));
  const b = time.parseDay(time.localDayOf(to, tz));
  return Math.round((Date.UTC(b.year, b.month - 1, b.dayOfMonth) - Date.UTC(a.year, a.month - 1, a.dayOfMonth)) / DAY_MS);
}

/**
 * Сколько календарных дней открытая сделка лежит на этапе (D-244), если это не меньше `staleDays` этапа; иначе null.
 * С поясом установки `tz` считаются местные сутки (перенос в 23:50 на следующий день уже «день»); без него — полные
 * 24-часовые интервалы. Не открытая сделка и этап без `staleDays` — null.
 */
export const staleDaysOf: StaleDaysOf = (deal, stage, now, tz) => {
  if (deal.status !== 'open' || !stage || stage.staleDays === null) return null;
  const days = tz ? calendarDaysBetween(deal.stageChangedAt, now, tz) : Math.floor((now - deal.stageChangedAt) / DAY_MS);
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

/**
 * Подписи полей сделки для текста отказа требований этапа (D-301): только поля из `requires.fields` этапов
 * `stageKeys` этой воронки и только из `visible` (поля сделки, не скрытые роли зрителя). Прочие подписи из
 * настроек клиенту не уходят: скрытых полей в ответе нет, даже их названий.
 */
export function stageFieldLabels<L>(
  pipeline: Pick<DealPipelineInfo, 'stages'> | undefined,
  stageKeys: readonly string[],
  labels: Readonly<Record<string, L>>,
  visible: ReadonlySet<string>,
): Record<string, L> {
  const out: Record<string, L> = {};
  if (!pipeline) return out;
  const wanted = new Set(stageKeys);
  for (const s of pipeline.stages) {
    if (!wanted.has(s.key)) continue;
    for (const k of s.requires.fields) {
      if (visible.has(k) && Object.hasOwn(labels, k)) out[k] = labels[k] as L;
    }
  }
  return out;
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
