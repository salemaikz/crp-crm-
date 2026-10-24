// Варианты услуг для формы покупки (D-348): плитки «{услуга} · {вариант} · {цена} ₸». Цены — из настроек установки.

export interface PurchaseVariant {
  serviceKey: string;
  variantKey: string;
  serviceLabel: string;
  variantLabel: string;
  amountKzt: number;
}

interface ServiceDoc {
  key: string;
  label?: { ru?: string } | undefined;
  archived?: boolean | undefined;
  variants?: ReadonlyArray<{ key: string; label?: { ru?: string } | undefined; amountKzt: number; archived?: boolean | undefined }> | undefined;
}

/** Плитки по `serviceTypes[].variants[]`: архивные услуги и варианты скрыты, порядок — как в настройках. */
export function purchaseVariants(doc: { serviceTypes?: readonly ServiceDoc[] | undefined } | null | undefined): PurchaseVariant[] {
  const out: PurchaseVariant[] = [];
  for (const s of doc?.serviceTypes ?? []) {
    if (s.archived) continue;
    for (const v of s.variants ?? []) {
      if (v.archived) continue;
      out.push({ serviceKey: s.key, variantKey: v.key, serviceLabel: s.label?.ru ?? s.key, variantLabel: v.label?.ru ?? v.key, amountKzt: v.amountKzt });
    }
  }
  return out;
}

/** Ключ плитки: `услуга/вариант`. */
export const tileKey = (serviceKey: string, variantKey: string): string => `${serviceKey}/${variantKey}`;

/**
 * Вариант для запроса покупки (D-357): ключ выбранной плитки, пока выбрана услуга этой плитки. «Другая услуга» (плитки нет)
 * и смена услуги вручную — без варианта. Правка суммы плитку не сбрасывает: цену можно поправить (скидка), вариант остаётся.
 */
export function variantKeyOf(selected: string | null, serviceKey: string): string | undefined {
  if (selected === null || serviceKey === '' || !selected.startsWith(`${serviceKey}/`)) return undefined;
  const key = selected.slice(serviceKey.length + 1);
  return key === '' ? undefined : key;
}
