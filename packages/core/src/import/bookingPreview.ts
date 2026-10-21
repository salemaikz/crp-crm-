// Предпросмотр импорта «Записи» (D-324, docs/import-bookings-design.md §6): что будет с каждой строкой таблицы.
// Чистая функция без БД: кандидаты, мероприятия, записи клиентов, прошлые загрузки и карта авторов приходят
// параметрами, «сейчас» и «сегодня» — тоже. В результате только id, коды и числа — без имён и номеров.

import { normalizeLabel } from './answer';
import { authorDecision, matchBookingClient, type AuthorMap, type BookingClientKeys, type BookingMatchBy } from './bookingMatch';
import type { ParsedBookingRow } from './bookingRows';

export type BookingAction =
  | 'invalid'
  | 'skip_same'
  | 'changed_in_file'
  | 'unsupported_type'
  | 'client_not_found'
  | 'client_ambiguous'
  | 'past_event'
  | 'no_event'
  | 'event_cancelled'
  | 'event_ambiguous'
  | 'duplicate_in_file'
  | 'booking_exists'
  | 'booking_conflict'
  | 'kept_in_crm'
  | 'state_conflict'
  | 'event_full'
  | 'create';

export const BOOKING_ACTIONS: readonly BookingAction[] = [
  'invalid',
  'skip_same',
  'changed_in_file',
  'unsupported_type',
  'client_not_found',
  'client_ambiguous',
  'past_event',
  'no_event',
  'event_cancelled',
  'event_ambiguous',
  'duplicate_in_file',
  'booking_exists',
  'booking_conflict',
  'kept_in_crm',
  'state_conflict',
  'event_full',
  'create',
];

/** Группы отчёта РОП (строка может входить в несколько: запись создана, но автор неизвестен). */
export type BookingGroup = 'errors' | 'client_not_found' | 'no_event' | 'author_unknown' | 'duplicate' | 'review';
export const BOOKING_GROUPS: readonly BookingGroup[] = ['errors', 'client_not_found', 'no_event', 'author_unknown', 'duplicate', 'review'];

/** Замечания к строке `create` (входят в отпечаток). */
export type BookingFlag = 'owner_from_author' | 'card_unowned' | 'card_held' | 'author_unknown';

export type BookingTransition = 'to_agreed' | 'none';

/** Состояния карточки, в которых запись не создаётся: карточка закрыта (PROCESS 3.1). */
const CLOSED_STATES: ReadonlySet<string> = new Set(['not_interested', 'not_target', 'written_off', 'do_not_call']);
/** Состояния, из которых «Договорились» ставит ядро (`import_agreed`, № 30 r30c). */
const AGREE_FROM: ReadonlySet<string> = new Set(['new', 'retry', 'callback']);
/** Записи, занимающие место (D-131) и активные (ожидают мероприятия). */
const OCCUPYING: ReadonlySet<string> = new Set(['registered', 'confirmed', 'attended', 'no_show']);
const ACTIVE: ReadonlySet<string> = new Set(['registered', 'confirmed']);

export interface BookingCard {
  cardId: string;
  state: string;
  ownerUserId: string | null;
  holdReason: string;
  touchedInCrm: boolean;
}

export type BookingCandidate = BookingClientKeys & BookingCard & { clientId: string };

export interface BookingEventInfo {
  id: string;
  typeKey: string;
  date: string;
  /** 'HH:MM'. */
  time: string;
  status: 'scheduled' | 'cancelled';
  capacity: number;
  /** Занято мест: записи со статусом из `registered, confirmed, attended, no_show`. */
  taken: number;
  startsAt: number;
}

/** Запись клиента, держащая место (любая из четырёх). */
export interface ClientBookingInfo {
  clientId: string;
  eventId: string | null;
  typeKey: string;
  status: string;
  startsAt: number;
}

/** Запись, загруженная раньше с этим ключом (в любом статусе). `stateKey` null — истории `import` нет. */
export interface PriorBooking {
  bookingId: string;
  stateKey: string | null;
}

export interface BookingPreviewInput {
  rows: readonly ParsedBookingRow[];
  /** Ключи групповых видов; остальные виды (консультации) не загружаются. */
  groupTypeKeys: ReadonlySet<string>;
  candidates: readonly BookingCandidate[];
  events: readonly BookingEventInfo[];
  clientBookings: readonly ClientBookingInfo[];
  /** `bookings.import_key` → прошлое состояние. */
  prior: ReadonlyMap<string, PriorBooking>;
  importKeyOf: (row: ParsedBookingRow) => string;
  authorMap: AuthorMap;
  /** Активные участники раздачи пространства: автору из них отдаётся карточка без владельца (D-222). */
  participants: ReadonlySet<string>;
  /** Местный день установки 'YYYY-MM-DD' и «сейчас». */
  today: string;
  now: number;
  /** `iin:<HMAC>` от открытого БИН: сверка неуверенно скрытого номера. */
  hidden?: (bin: string) => string;
}

export interface BookingPreviewRow {
  rowNo: number;
  action: BookingAction;
  groups: BookingGroup[];
  flags: BookingFlag[];
  clientId: string | null;
  cardId: string | null;
  eventId: string | null;
  /** Автор записи; null — неизвестен. */
  authorUserId: string | null;
  transition: BookingTransition;
  /** Владелец карточки после применения. */
  ownerAfter: string | null;
  matchBy: BookingMatchBy | null;
  /** Запись, загруженная раньше с этим ключом (`skip_same`, `changed_in_file`). */
  bookingId: string | null;
  issues: string[];
}

export interface BookingEventLine {
  eventId: string;
  typeKey: string;
  date: string;
  time: string;
  /** Будет записано этим импортом. */
  create: number;
  taken: number;
  capacity: number;
}

export interface BookingPreviewCounts {
  total: number;
  byAction: Record<BookingAction, number>;
  byGroup: Record<BookingGroup, number>;
  byFlag: Record<BookingFlag, number>;
  /** Карточки, которые перейдут в «Договорились». */
  toAgreed: number;
}

export interface BookingPreview {
  rows: BookingPreviewRow[];
  counts: BookingPreviewCounts;
  byEvent: BookingEventLine[];
  /** Ярлыки (как в файле) строк `create`, у которых нет решения РОП: блокер `unmapped_authors`. */
  unmappedAuthors: string[];
}

const GROUP_OF: Partial<Record<BookingAction, BookingGroup>> = {
  invalid: 'errors',
  skip_same: 'duplicate',
  changed_in_file: 'review',
  unsupported_type: 'no_event',
  client_not_found: 'client_not_found',
  client_ambiguous: 'client_not_found',
  past_event: 'no_event',
  no_event: 'no_event',
  event_cancelled: 'no_event',
  event_ambiguous: 'no_event',
  duplicate_in_file: 'duplicate',
  booking_exists: 'duplicate',
  booking_conflict: 'review',
  kept_in_crm: 'review',
  state_conflict: 'review',
  event_full: 'no_event',
};

export function buildBookingPreview(input: BookingPreviewInput): BookingPreview {
  const bookingsOf = new Map<string, ClientBookingInfo[]>();
  for (const b of input.clientBookings) {
    const list = bookingsOf.get(b.clientId) ?? [];
    list.push(b);
    bookingsOf.set(b.clientId, list);
  }
  const eventsByKey = new Map<string, BookingEventInfo[]>();
  for (const e of input.events) {
    const k = `${e.typeKey}|${e.date}`;
    const list = eventsByKey.get(k) ?? [];
    list.push(e);
    eventsByKey.set(k, list);
  }

  const byAction = Object.fromEntries(BOOKING_ACTIONS.map((a) => [a, 0])) as Record<BookingAction, number>;
  const byGroup = Object.fromEntries(BOOKING_GROUPS.map((g) => [g, 0])) as Record<BookingGroup, number>;
  const byFlag: Record<BookingFlag, number> = { owner_from_author: 0, card_unowned: 0, card_held: 0, author_unknown: 0 };
  let toAgreed = 0;
  /** Ключи строк, уже встретившихся выше в файле. */
  const seenKeys = new Set<string>();
  /** Пара «клиент, мероприятие», дошедшая до проверки дубля: вторая такая строка — `duplicate_in_file`. */
  const seenPairs = new Set<string>();
  /** Мест, занятых строками `create` выше по файлу, по мероприятиям. */
  const createdOn = new Map<string, number>();
  /** Мероприятие, на которое строка `create` выше записала клиента данного вида (для конфликта). */
  const createdByClientType = new Map<string, string>();
  const unmapped = new Map<string, string>();
  const lines = new Map<string, BookingEventLine>();

  const rows = input.rows.map((row): BookingPreviewRow => {
    const pr: BookingPreviewRow = {
      rowNo: row.rowNo,
      action: 'create',
      groups: [],
      flags: [],
      clientId: null,
      cardId: null,
      eventId: null,
      authorUserId: null,
      transition: 'none',
      ownerAfter: null,
      matchBy: null,
      bookingId: null,
      issues: row.issues.map((i) => i.code),
    };
    const done = (action: BookingAction): BookingPreviewRow => {
      pr.action = action;
      byAction[action]++;
      const g = GROUP_OF[action];
      if (g) pr.groups.push(g);
      if (action === 'create') {
        if (pr.flags.includes('card_unowned') || pr.flags.includes('card_held')) pr.groups.push('review');
        if (pr.flags.includes('author_unknown')) pr.groups.push('author_unknown');
      }
      for (const grp of new Set(pr.groups)) byGroup[grp]++;
      pr.groups = [...new Set(pr.groups)];
      for (const f of pr.flags) byFlag[f]++;
      return pr;
    };

    // 1. ошибки разбора
    if (row.issues.some((i) => i.severity === 'error')) return done('invalid');

    // Та же строка (ключ) уже была выше в файле: повтор строки, а не новое состояние. Иначе две одинаковые строки
    // с разными операторами после загрузки давали бы «сменился автор» при каждом повторе файла.
    const key = input.importKeyOf(row);
    if (seenKeys.has(key)) return done('duplicate_in_file');
    seenKeys.add(key);

    // 2–3. запись этого ключа уже загружалась: до поиска клиента (его могли слить, запись — отменить)
    const prior = input.prior.get(key);
    if (prior) {
      pr.bookingId = prior.bookingId;
      return done(prior.stateKey === null || prior.stateKey === row.stateKey ? 'skip_same' : 'changed_in_file');
    }

    // 4. индивидуальные виды (консультации) не загружаются
    if (!row.eventTypeKey || !input.groupTypeKeys.has(row.eventTypeKey)) return done('unsupported_type');

    // 5. клиент
    const match = matchBookingClient(row, input.candidates, input.hidden);
    if (match.kind === 'not_found') return done('client_not_found');
    if (match.kind === 'ambiguous') return done('client_ambiguous');
    const client = match.candidate;
    pr.clientId = client.clientId;
    pr.cardId = client.cardId;
    pr.matchBy = match.by;

    // 6. прошедшие мероприятия: явка неизвестна, сверка явки создала бы ложные задачи
    if (!row.eventDate || row.eventDate < input.today) return done('past_event');

    // 7. мероприятие: вид, дата и (если есть) время
    const sameDay = eventsByKey.get(`${row.eventTypeKey}|${row.eventDate}`) ?? [];
    const fits = sameDay.filter((e) => row.eventTime === null || e.time === row.eventTime);
    const scheduled = fits.filter((e) => e.status === 'scheduled');
    if (scheduled.length === 0) return done(fits.length > 0 ? 'event_cancelled' : 'no_event');
    if (scheduled.length > 1) return done('event_ambiguous');
    const ev = scheduled[0] as BookingEventInfo;
    pr.eventId = ev.id;

    // 8. та же пара выше в файле
    const pair = `${client.clientId}|${ev.id}`;
    if (seenPairs.has(pair)) return done('duplicate_in_file');
    seenPairs.add(pair);

    // 9–10. записи клиента в БД: то же мероприятие — дубль; будущая запись того же вида на другое — конфликт (переносит РОП)
    const mine = bookingsOf.get(client.clientId) ?? [];
    const same = mine.find((b) => b.eventId === ev.id && OCCUPYING.has(b.status));
    if (same) return done('booking_exists');
    const conflictAbove = createdByClientType.get(`${client.clientId}|${ev.typeKey}`);
    if (conflictAbove !== undefined && conflictAbove !== ev.id) return done('booking_conflict');
    if (mine.some((b) => b.typeKey === ev.typeKey && ACTIVE.has(b.status) && b.startsAt > input.now && b.eventId !== ev.id)) return done('booking_conflict');

    // 11–12. карточка: тронута в CRM — ведёт CRM; закрыта — запись не нужна
    if (client.touchedInCrm) return done('kept_in_crm');
    if (CLOSED_STATES.has(client.state)) return done('state_conflict');

    // 13. места: занято в БД + записано строками выше
    if (ev.taken + (createdOn.get(ev.id) ?? 0) >= ev.capacity) return done('event_full');

    // 14. создаём запись: автор и переход карточки
    const decision = authorDecision(input.authorMap, row.authorLabel);
    if (!decision.decided && row.authorLabel !== null) unmapped.set(normalizeLabel(row.authorLabel), row.authorLabel);
    pr.authorUserId = decision.userId;
    if (decision.userId === null) pr.flags.push('author_unknown');

    const canAgree = AGREE_FROM.has(client.state);
    if (client.holdReason !== '') {
      pr.flags.push('card_held');
      pr.ownerAfter = client.ownerUserId;
    } else if (!canAgree) {
      // «Договорились»/«Клиент»: ещё одна запись, карточка остаётся как есть
      pr.ownerAfter = client.ownerUserId;
      if (client.ownerUserId === null) pr.flags.push('card_unowned');
    } else if (client.ownerUserId !== null) {
      pr.transition = 'to_agreed';
      pr.ownerAfter = client.ownerUserId;
    } else if (decision.userId !== null && input.participants.has(decision.userId)) {
      pr.transition = 'to_agreed';
      pr.ownerAfter = decision.userId;
      pr.flags.push('owner_from_author');
    } else {
      pr.flags.push('card_unowned');
    }
    if (pr.transition === 'to_agreed') toAgreed++;

    createdOn.set(ev.id, (createdOn.get(ev.id) ?? 0) + 1);
    createdByClientType.set(`${client.clientId}|${ev.typeKey}`, ev.id);
    const line = lines.get(ev.id) ?? { eventId: ev.id, typeKey: ev.typeKey, date: ev.date, time: ev.time, create: 0, taken: ev.taken, capacity: ev.capacity };
    line.create++;
    lines.set(ev.id, line);
    return done('create');
  });

  return {
    rows,
    counts: { total: rows.length, byAction, byGroup, byFlag, toAgreed },
    byEvent: [...lines.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.eventId.localeCompare(b.eventId)),
    unmappedAuthors: [...unmapped.values()].sort(),
  };
}
