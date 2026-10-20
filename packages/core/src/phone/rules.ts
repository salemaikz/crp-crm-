import type { PhoneKind, PhoneRules } from './types.js';

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/**
 * Значения по умолчанию из CONFIG §6.3 (колонка «По умолчанию»), канон `KZ`. Установка
 * переопределяет их настройками; функции ядра всегда принимают правила параметром.
 */
export const DEFAULT_PHONE_RULES: PhoneRules = {
  country: 'KZ',
  mobilePrefixes: [
    ...range(700, 709),
    '747',
    '750',
    '751',
    ...range(760, 764),
    '771',
    ...range(775, 778),
  ],
  reviewPrefixes: ['770', '774'],
  landlinePrefixes: ['71x', '72x'],
};

/** Совпадение национальной части (10 цифр, без «7») с префиксом; `x` — любая цифра. */
export function matchesPrefix(national: string, prefix: string): boolean {
  if (prefix.length === 0 || prefix.length > national.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const p = prefix[i]!;
    if (p === 'x' || p === 'X') continue;
    if (national[i] !== p) return false;
  }
  return true;
}

const matchesAny = (national: string, prefixes: readonly string[]): boolean =>
  prefixes.some((p) => matchesPrefix(national, p));

/** Тип по префиксу и признак «проверить номер». `national` — 10 цифр после «7». */
export function classifyNational(
  national: string,
  rules: PhoneRules,
): { kind: PhoneKind; needsReview: boolean } {
  if (matchesAny(national, rules.reviewPrefixes)) return { kind: 'mobile', needsReview: true };
  if (matchesAny(national, rules.mobilePrefixes)) return { kind: 'mobile', needsReview: false };
  if (matchesAny(national, rules.landlinePrefixes)) return { kind: 'landline', needsReview: false };
  return { kind: 'unknown', needsReview: false };
}
