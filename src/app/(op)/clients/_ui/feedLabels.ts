// Подписи событий ленты по виду и данным (PROCESS 9.1). Чистая функция: возвращает ключ сообщения и
// параметры, текст собирает next-intl. Вид без подписи показывается общей строкой — лента не падает.
import type { FeedItemView, FeedLabels } from './types';

export type DescribeContext = {
  /** Подпись поля: системного (по ключу колонки) или из настроек. */
  fieldLabel: (obj: string, field: string, sys: boolean) => string;
  /** Подпись значения: варианты списков, форма собственности, да/нет; пустое — «—». */
  valueLabel: (obj: string, field: string, sys: boolean, value: unknown) => string;
  /** Номер телефона по id из текущего списка номеров (нет в списке — общая подпись). */
  phoneLabel: (phoneId: string) => string;
  /** Имя контакта по id из текущего списка (нет в списке — общая подпись). */
  contactLabel: (contactId: string) => string;
  /** Подпись итога звонка по ключу из настроек (нет — пусто). */
  outcomeLabel: (outcome: string) => string;
  /** Подпись причины итога (нет — пусто). */
  reasonLabel: (outcome: string, reason: string) => string;
  /** Короткая подпись вида мероприятия (нет — пусто). */
  eventLabel: (eventTypeKey: string) => string;
  /** Подпись этапа сделки (нет — сам ключ). */
  stageLabel: (stageKey: string) => string;
  /** Подпись колонки доски для состояния карточки (нет доски — пусто). */
  columnLabel: (state: string) => string;
  /** Срок с учётом точности: «пн 26.10 11:00» или «пн 26.10». */
  dueLabel: (at: number, precision: 'time' | 'day') => string;
  /** Длительность разговора: «1 мин 35 с». */
  durationLabel: (sec: number) => string;
  /** Подпись статуса записи (нет — пусто). */
  bookingStatusLabel: (status: string) => string;
  /** День мероприятия `YYYY-MM-DD` → «28.10.2026». */
  dayLabel: (day: string) => string;
};

export type Described = { key: string; values: Record<string, string | number> };

/** Событие ленты, из которого строится подпись: вид, данные и то, что дочитано по ссылке (звонок, запись, задача). */
export type DescribeItem = Pick<FeedItemView, 'kind' | 'data'> & Partial<Pick<FeedItemView, 'call' | 'ref'>>;

/** Виды, у которых есть подпись в messages/ru/clients.json (feed.kinds.*). */
export const DESCRIBED_KINDS = [
  'field.changed',
  'phone.added',
  'phone.not_working',
  'phone.primary',
  'contact.added',
  'contact.archived',
  'call',
  'call.voided',
  'note.created',
  'booking.created',
  'booking.moved',
  'booking.status',
  'deal.created',
  'deal.stage',
  'deal.lost',
  'card.created',
  'card.state',
  'card.assigned',
  'card.released',
  'card.transferred',
  'card.acting',
  'card.merged',
  'dnc.set',
  'dnc.cleared',
  'import.row',
  'client.created',
  'message',
  'messenger.link_opened',
  'client.merged',
  'task.created',
  'task.done',
  'task.cancelled',
  'task.comment',
] as const;

/** Состояния карточки, для которых в локали есть отдельная подпись `feed.kinds.cardState.<состояние>`. */
export const CARD_STATES = ['new', 'retry', 'callback', 'agreed', 'client', 'not_interested', 'not_target', 'do_not_call', 'written_off'] as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function describeEvent(item: DescribeItem, ctx: DescribeContext): Described {
  const d = item.data;
  switch (item.kind) {
    case 'field.changed': {
      const obj = str(d.obj);
      const field = str(d.field);
      const sys = d.sys === true;
      const base = {
        field: ctx.fieldLabel(obj, field, sys),
        before: ctx.valueLabel(obj, field, sys, d.before),
        after: ctx.valueLabel(obj, field, sys, d.after),
      };
      if (obj === 'contact') return { key: 'feed.kinds.contactFieldChanged', values: { ...base, contact: ctx.contactLabel(str(d.contactId)) } };
      return { key: 'feed.kinds.fieldChanged', values: base };
    }
    case 'phone.added':
    case 'phone.not_working':
    case 'phone.primary':
      return { key: `feed.kinds.${item.kind.replace('.', '_')}`, values: { phone: ctx.phoneLabel(str(d.phoneId)) } };
    case 'contact.added':
    case 'contact.archived':
      return { key: `feed.kinds.${item.kind.replace('.', '_')}`, values: { contact: ctx.contactLabel(str(d.contactId)) } };
    case 'call': {
      // Итог внёс РОП с доски «Обзвон» (D-266): отметка «внесено РОП»
      const manual = d.via === 'manual_entry';
      const outcome = ctx.outcomeLabel(str(d.outcome));
      if (outcome === '') return { key: manual ? 'feed.kinds.call_manual' : 'feed.kinds.call', values: {} };
      const reason = ctx.reasonLabel(str(d.outcome), item.call?.reasonCode ?? '');
      const at = item.call?.callbackAt ?? null;
      const sec = typeof d.durationSec === 'number' ? d.durationSec : 0;
      return {
        key: 'feed.kinds.callOutcome',
        values: {
          outcome,
          reason: reason || 'none',
          callback: at === null ? 'none' : ctx.dueLabel(at, item.call?.callbackPrecision ?? 'time'),
          duration: sec > 0 ? ctx.durationLabel(sec) : 'none',
          manual: manual ? 'yes' : 'no',
        },
      };
    }
    case 'booking.created': {
      const event = ctx.eventLabel(str(d.eventTypeKey));
      const day = str(d.eventDate);
      if (event === '' || day === '') return { key: 'feed.kinds.booking_created', values: {} };
      return { key: 'feed.kinds.bookingCreated', values: { event, date: ctx.dayLabel(day), time: str(d.startTime) } };
    }
    case 'booking.status': {
      const event = ctx.eventLabel(item.ref?.eventTypeKey ?? '');
      const status = ctx.bookingStatusLabel(str(d.to));
      if (event === '' || status === '') return { key: 'feed.kinds.booking_status', values: {} };
      return { key: 'feed.kinds.bookingStatus', values: { event, status } };
    }
    case 'deal.stage': {
      const from = str(d.from);
      const to = str(d.to);
      if (from === '' || to === '') return { key: 'feed.kinds.deal_stage', values: {} };
      return { key: 'feed.kinds.dealStage', values: { from: ctx.stageLabel(from), to: ctx.stageLabel(to) } };
    }
    case 'task.created': {
      const due = typeof d.dueAt === 'number' ? d.dueAt : null;
      if (due === null) return { key: 'feed.kinds.task_created', values: {} };
      return { key: 'feed.kinds.taskCreated', values: { due: ctx.dueLabel(due, item.ref?.duePrecision ?? 'time') } };
    }
    case 'call.voided':
    case 'note.created':
    case 'booking.moved':
    case 'deal.created':
    case 'deal.lost':
    case 'card.created':
    case 'card.assigned':
    case 'card.released':
    case 'card.transferred':
    case 'card.acting':
    case 'card.merged':
    case 'dnc.set':
    case 'dnc.cleared':
    case 'import.row':
    case 'client.created':
    case 'message':
    case 'messenger.link_opened':
    case 'client.merged':
    case 'task.done':
    case 'task.cancelled':
    case 'task.comment':
      return { key: `feed.kinds.${item.kind.replace('.', '_')}`, values: {} };
    case 'card.state': {
      // Новое состояние в подписи; незнакомое (новая версия ядра) — общая строка
      const to = str(d.toState);
      const column = ctx.columnLabel(to);
      if (column !== '') return { key: 'feed.kinds.cardColumn', values: { column } };
      return (CARD_STATES as readonly string[]).includes(to) ? { key: `feed.kinds.cardState.${to}`, values: {} } : { key: 'feed.kinds.card_state', values: {} };
    }
    default:
      return { key: 'feed.kinds.unknown', values: {} };
  }
}

/** Ключи сообщений подписей системных полей: `<объект>:<колонка>` → путь в messages/ru/clients.json. */
export const SYSTEM_LABEL_KEYS: Readonly<Record<string, string>> = {
  'client:name': 'fields.name',
  'client:legal_form': 'fields.legalForm',
  'client:org_id': 'fields.orgId',
  'client:region': 'fields.region',
  'client:address': 'fields.address',
  'client:email': 'fields.email',
  'client:website': 'fields.website',
  'contact:name': 'contacts.name',
  'contact:position': 'contacts.position',
  'contact:is_decision_maker': 'contacts.isDecisionMaker',
  'contact:call_hint': 'contacts.callHint',
  'contact:note': 'contacts.note',
};

/** Собрать контекст подписей из данных страницы и готовых строк локали. */
export function makeContext(
  labels: FeedLabels,
  text: {
    yes: string;
    no: string;
    empty: string;
    system: (messageKey: string) => string;
    unknownField: string;
    unknownPhone: string;
    unknownContact: string;
    dueLabel: (at: number, precision: 'time' | 'day') => string;
    durationLabel: (sec: number) => string;
    bookingStatusLabel: (status: string) => string;
    dayLabel: (day: string) => string;
  },
): DescribeContext {
  const optionLabel = (obj: string, field: string, sys: boolean, key: string): string =>
    (sys && field === 'legal_form' ? labels.options[`legal_form:${key}`] : labels.options[`${obj}:${field}:${key}`]) ?? key;
  return {
    fieldLabel: (obj, field, sys) => {
      const sysKey = SYSTEM_LABEL_KEYS[`${obj}:${field}`];
      if (sys) return sysKey ? text.system(sysKey) : field;
      return labels.fields[`${obj}:${field}`] ?? text.unknownField;
    },
    valueLabel: (obj, field, sys, value) => {
      if (value === null || value === undefined || value === '') return text.empty;
      if (typeof value === 'boolean') return value ? text.yes : text.no;
      if (Array.isArray(value)) return value.map((v) => optionLabel(obj, field, sys, String(v))).join(', ');
      if (typeof value === 'string') return optionLabel(obj, field, sys, value);
      return String(value);
    },
    phoneLabel: (id) => labels.phones[id] ?? text.unknownPhone,
    contactLabel: (id) => labels.contacts[id] ?? text.unknownContact,
    outcomeLabel: (outcome) => labels.outcomes[outcome] ?? '',
    reasonLabel: (outcome, reason) => (reason === '' ? '' : (labels.reasons[`${outcome}:${reason}`] ?? '')),
    eventLabel: (key) => labels.events[key] ?? '',
    stageLabel: (key) => labels.stages[key] ?? key,
    columnLabel: (state) => labels.columns[state] ?? '',
    dueLabel: text.dueLabel,
    durationLabel: text.durationLabel,
    bookingStatusLabel: text.bookingStatusLabel,
    dayLabel: text.dayLabel,
  };
}

/**
 * Системное событие, которое сворачивается в одну строку. Смена состояния карточки остаётся в ленте
 * только когда есть подписи колонок доски (OP_BOARD включён и пресет доски задан).
 */
export const isFoldedEvent = (i: FeedItemView, hasBoard: boolean): boolean => i.group === 'system' && (i.kind !== 'card.state' || !hasBoard);
