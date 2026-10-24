// Деньги на доске и в «Моих покупках»: целые тенге символом валюты («240 000 ₸»), как в отчётах (ui-polish §9.9).
import type { useFormatter } from 'next-intl';

export const formatKzt = (f: ReturnType<typeof useFormatter>, n: number): string =>
  f.number(n, { style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
