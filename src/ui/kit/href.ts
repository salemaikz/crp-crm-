// Источник: платформа LMS 2cd8a2b src/components/ui/href.ts (адаптировано под CRM)
/** Ссылка ведёт наружу (или это якорь/почта/телефон) — рендерим обычный <a>, а не next/link. */
export function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:|#|\/\/)/i.test(href);
}
