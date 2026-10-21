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
  // B5: консультации — консультанту в его график, автору записи и руководителю — в записи
  booking_consult_new: '/consultations',
  consultant_assigned: '/bookings',
  grey_suggest: '/bookings',
  // B6: покупка по клиенту владельца карточки — в клиенты; передачи — в раздел передач
  deal_won: '/clients',
  handoff_new: '/handoffs',
  handoff_assigned: '/handoffs',
  handoff_declined: '/handoffs',
  handoff_cancelled: '/handoffs',
  // O6, O7a: новый канал и сбой обработки событий — администратору на экран «Интеграции»
  messenger_channel_new: '/integrations',
  integration_inbox_failed: '/integrations',
};

/**
 * Известные виды без ссылки. Полная выгрузка (R3b, PROCESS 8.6): журнал видят не все получатели (РОП — нет), поэтому
 * ссылки нет, текст отсылает к журналу. Резерв, ставший основной записью, получают и консультант, и владелец
 * карточки — общего экрана у них нет. Состояние канала и пределы мессенджера получают руководители без доступа
 * к экрану «Интеграции». Сброс часов лицензии (D-314) — экрана лицензии нет, подробности в журнале аудита.
 */
const TEXT_ONLY = ['export_full_done', 'reserve_promoted', 'messenger_channel_down', 'messenger_flood', 'messenger_dnc_unknown', 'license_clock_reset'];

const KNOWN = new Set([...Object.keys(HREF), ...TEXT_ONLY]);

export const isKnownKind = (kind: string): boolean => KNOWN.has(kind);
export const hrefForKind = (kind: string): string | undefined => HREF[kind];
export const isTextOnlyKind = (kind: string): boolean => TEXT_ONLY.includes(kind);
export const isAlarmKind = (kind: string): boolean => kind.startsWith('alarm_');

/** Только числа и строки: чужие значения params в текст не подставляем. */
export function icuValues(params: Record<string, number | string>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(params)) if (typeof v === 'number' || typeof v === 'string') out[k] = v;
  return out;
}
