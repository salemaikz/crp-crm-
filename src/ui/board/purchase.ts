// Подписи покупки (D-357): строка 1 — «{услуга} · {вариант}» из настроек, строка 2 — «{сумма} · {дата}».
// Подписи услуг и вариантов приходят из настроек страницы (`loadBoardConfig`); сырой ключ в интерфейс не попадает.

/** Услуга по ключу: подпись и подписи её вариантов по ключу варианта. */
export type ServiceLabels = Record<string, { label: string; variants: Record<string, string> }>;

export function serviceLine(service: string | null | undefined, variant: string | null | undefined, labels: ServiceLabels): string {
  if (!service || !Object.hasOwn(labels, service)) return '';
  const s = labels[service]!;
  const v = variant && Object.hasOwn(s.variants, variant) ? s.variants[variant] : undefined;
  return v ? `${s.label} · ${v}` : s.label;
}

export const purchaseAmountLine = (sum: string, date: string): string => [sum, date].filter((x) => x !== '').join(' · ');
