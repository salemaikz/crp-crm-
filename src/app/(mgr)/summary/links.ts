// Ссылки сводки (A7): на доску по контракту К1 (`tab`, `f`, `owner`) и на «Записи». Без доски ссылок нет.

/** Просроченные перезвоны: колонка роли «перезвон», фильтр «на сегодня», при необходимости сотрудник. */
export function overdueHref(callbackTab: string | null, ownerId?: string): string | null {
  if (callbackTab === null) return null;
  const owner = ownerId === undefined ? '' : `&owner=${encodeURIComponent(ownerId)}`;
  return `/deals/calling?tab=${encodeURIComponent(callbackTab)}&f=today${owner}`;
}

/** «Записи»: только когда доска включена (иначе страница сводки остаётся без переходов). */
export function bookingsHref(boardOn: boolean): string | null {
  return boardOn ? '/bookings' : null;
}
