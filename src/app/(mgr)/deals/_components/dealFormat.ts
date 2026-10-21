// Подписи страницы сделки: вид события журнала → ключ локали, день записи → короткая дата.

/**
 * Ключ подписи `history.<ключ>` для вида события журнала. Вид пишется через точку (`deal.won`), а next-intl читает
 * точку в ключе как вложенность, поэтому в локали точка заменена на подчёркивание (`deal_won`), как в ленте
 * клиента. `has` проверяет, есть ли такой ключ; нет — общий `other`.
 */
export function historyLabelKey(kind: string, has: (key: string) => boolean): string {
  const key = kind.replace(/\./g, '_');
  return has(key) ? key : 'other';
}

/** День записи `2026-10-21` → «21 окт.»; не дата — как есть. Без пояса: это календарный день, а не момент. */
export function bookingDayLabel(day: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at);
}
