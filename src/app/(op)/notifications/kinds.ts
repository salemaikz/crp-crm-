// Соответствие вида уведомления и экрана, куда оно ведёт. Неизвестный вид (от другого модуля) — без ссылки.
const HREF: Record<string, string> = {
  digest_operator: '/call',
  digest_manager: '/distribution',
  alarm_callbacks_overdue: '/summary',
  alarm_handoff_unaccepted: '/handoffs',
  alarm_grey_unassigned: '/bookings',
  probe_limit: '/distribution',
  // B9a: переданные клиенты и дела отключённого сотрудника — в список клиентов; без получателя — в раздел «Без владельца»
  client_transferred: '/clients',
  staff_disabled: '/clients',
  staff_disabled_orphans: '/distribution',
  // Выдача карточек и замещение — к обзвону; без заместителя — в раздел «Без владельца»; задачи — на экран задач
  cards_assigned: '/call',
  absence_acting: '/clients',
  absence_no_substitute: '/distribution',
  task_assigned: '/tasks',
  task_comment: '/tasks',
  // B9b: карточка объединена с дублем — в список клиентов (самой карточки у получателя больше нет)
  card_merged: '/clients',
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
