// Соответствие вида уведомления и экрана, куда оно ведёт. Неизвестный вид (от другого модуля) — без ссылки.
const HREF: Record<string, string> = {
  digest_operator: '/call',
  digest_manager: '/distribution',
  alarm_callbacks_overdue: '/summary',
  alarm_handoff_unaccepted: '/handoffs',
  alarm_grey_unassigned: '/bookings',
};

const KNOWN = new Set(Object.keys(HREF));

export const isKnownKind = (kind: string): boolean => KNOWN.has(kind);
export const hrefForKind = (kind: string): string | undefined => HREF[kind];
export const isAlarmKind = (kind: string): boolean => kind.startsWith('alarm_');

/** Только числа и строки: чужие значения params в текст не подставляем. */
export function icuValues(params: Record<string, number | string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'number' || typeof v === 'string') out[k] = v;
  return out;
}
