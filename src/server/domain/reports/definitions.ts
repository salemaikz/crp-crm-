// Определения показателей отчётов (PROCESS 10.1, D-261, D-262): одно место для долей, «звонков в час» и видов.
import type { Rate } from './reportTypes';

/** Виды выдачи, новые для оператора (D-039): считаются в «Выдано». */
export const ISSUE_KINDS = ['auto', 'manual', 'return', 'inbound', 'proposal'] as const;

/** Итоги-закрытия с причиной: группы отчёта «Причины» (плюс потерянная сделка). */
export const CLOSING_KINDS = ['not_interested', 'not_target', 'do_not_call'] as const;

/** Доля в процентах с одним знаком; нулевой знаменатель — null. */
export function rate(n: number, d: number): Rate {
  if (d <= 0) return null;
  return Math.round((n / d) * 1000) / 10;
}

/** Звонков в час = итоги / часы в работе, один знак после запятой; нет часов — null. */
export function callsPerHour(outcomes: number, hours: number): number | null {
  if (hours <= 0) return null;
  return Math.round((outcomes / hours) * 10) / 10;
}

/** Мягкая отметка «ниже нормы»: только когда норма задана и есть часы в работе. Без блокировок. */
export function isBelowTarget(value: number | null, target: number | null): boolean {
  return target !== null && value !== null && value < target;
}

/** Сумма в тенге из bigint-строки postgres.js; не безопасное целое — ошибка (деньги не округляем). */
export function toKzt(value: string | number | null): number {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n)) throw new RangeError('reports: сумма вне безопасного целого');
  return n;
}
