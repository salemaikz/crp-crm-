// Чистые правила сделок (B6, docs/deals-handoffs-design.md §5). Здесь пока только срок «залежалась» (B4b);
// остальные правила (этапы, сумма, момент покупки) добавляет B6-1. Без БД и часов: `now` приходит параметром.
import type { StaleDaysOf } from './types';

export const DAY_MS = 86_400_000;

/**
 * Сколько календарных дней открытая сделка лежит на этапе (D-244), если это не меньше `staleDays` этапа; иначе null.
 * Не открытая сделка и этап без `staleDays` — null.
 */
export const staleDaysOf: StaleDaysOf = (deal, stage, now) => {
  if (deal.status !== 'open' || !stage || stage.staleDays === null) return null;
  const days = Math.floor((now - deal.stageChangedAt) / DAY_MS);
  return days >= stage.staleDays ? days : null;
};
