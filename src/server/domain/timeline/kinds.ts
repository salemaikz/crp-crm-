// Реестр видов событий ленты клиента (D-125, PROCESS 9.1). Вид не из реестра в ленту не попадает;
// `data` отдаётся только с перечисленными ключами. Подписи строит интерфейс по `kind` и `data`.
// Остальные виды (задачи, сообщения) добавляют их модули строкой сюда.

export const FEED_GROUPS = ['calls', 'messages', 'bookings', 'deals', 'tasks', 'notes', 'system'] as const;
export type FeedGroup = (typeof FEED_GROUPS)[number];

export type KindSpec = { group: FeedGroup; dataKeys: readonly string[] };

export const EVENT_KINDS = {
  // Поле было → стало; обе стороны — значения только видимых полей (фильтр в repo.ts)
  'field.changed': { group: 'system', dataKeys: ['obj', 'sys', 'field', 'before', 'after', 'contactId'] },
  // Номера в данные не пишем: номер берётся из списка номеров карточки
  'phone.added': { group: 'system', dataKeys: ['phoneId'] },
  'phone.not_working': { group: 'system', dataKeys: ['phoneId'] },
  'phone.primary': { group: 'system', dataKeys: ['phoneId'] },
  'contact.added': { group: 'system', dataKeys: ['contactId'] },
  'contact.archived': { group: 'system', dataKeys: ['contactId'] },
  // Звонки (C5): код итога, вид, состояния «было → стало», номер разговора, длительность.
  call: { group: 'calls', dataKeys: ['outcome', 'outcomeKind', 'kind', 'fromState', 'toState', 'factReason', 'phoneId', 'durationSec'] },
  'call.voided': { group: 'calls', dataKeys: ['callId'] },
  // Текст заметки берётся из notes при чтении (C8)
  'note.created': { group: 'notes', dataKeys: ['noteId'] },
  // Записи (D-020): только коды и id, подписи строит интерфейс
  'booking.created': { group: 'bookings', dataKeys: ['bookingId', 'eventId', 'eventTypeKey', 'eventDate', 'startTime', 'via'] },
  'booking.moved': { group: 'bookings', dataKeys: ['fromId', 'toId', 'fromEventId', 'toEventId'] },
  'booking.status': { group: 'bookings', dataKeys: ['bookingId', 'from', 'to', 'reason'] },
  // Сделки
  'deal.created': { group: 'deals', dataKeys: ['dealId', 'pipelineKey', 'stageKey'] },
  'deal.stage': { group: 'deals', dataKeys: ['dealId', 'from', 'to', 'cause', 'bookingId'] },
  'deal.lost': { group: 'deals', dataKeys: ['dealId', 'reasonCode'] },
  // Карточка обзвона (C5): только коды, id сотрудников и счётчики; номера и тексты в данные не пишутся
  'card.created': { group: 'system', dataKeys: ['sourceKey'] },
  'card.state': { group: 'system', dataKeys: ['fromState', 'toState', 'cause'] },
  'card.assigned': { group: 'system', dataKeys: ['toUserId', 'mode'] },
  'card.released': { group: 'system', dataKeys: ['fromUserId'] },
  'card.transferred': { group: 'system', dataKeys: ['fromUserId', 'toUserId'] },
  'card.acting': { group: 'system', dataKeys: ['actingUserId', 'untilDay'] },
  'card.merged': { group: 'system', dataKeys: ['otherCardId', 'stateFrom'] },
  'dnc.set': { group: 'system', dataKeys: ['phonesAdded', 'phonesToReview'] },
  'dnc.cleared': { group: 'system', dataKeys: ['phonesRemoved'] },
  // Загрузка таблицы (C4). Сырой текст ячеек (ответ, заметка) в data не пишется (D-221): он может содержать ПДн
  // и живёт только в import_rows до чистки по сроку. Ключ строки и ключ состояния — служебные хэши (для сверки
  // повторной загрузки), `deferred` — итог отложен; в ленту они не идут.
  'import.row': { group: 'system', dataKeys: ['importId', 'rowNo', 'action', 'outcomeKey'] },
  'client.created': { group: 'system', dataKeys: ['sourceKind', 'importId'] },
} as const satisfies Record<string, KindSpec>;

export type EventKind = keyof typeof EVENT_KINDS;

export function isKnownKind(kind: string): kind is EventKind {
  return Object.hasOwn(EVENT_KINDS, kind);
}

export function groupOf(kind: string): FeedGroup | null {
  return isKnownKind(kind) ? EVENT_KINDS[kind].group : null;
}

/** Виды выбранных групп; без групп — все виды реестра. */
export function kindsOfGroups(groups: readonly FeedGroup[] | null): string[] {
  const all = Object.keys(EVENT_KINDS);
  if (!groups || groups.length === 0) return all;
  return all.filter((k) => groups.includes(EVENT_KINDS[k as EventKind].group));
}

/** Оставить в `data` только ключи вида из реестра. */
export function pickData(kind: string, data: unknown): Record<string, unknown> {
  if (!isKnownKind(kind) || typeof data !== 'object' || data === null || Array.isArray(data)) return {};
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of EVENT_KINDS[kind].dataKeys) if (Object.hasOwn(src, k)) out[k] = src[k];
  return out;
}
