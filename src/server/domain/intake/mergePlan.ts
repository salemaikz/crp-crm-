// Чистая часть слияния клиентов (docs/tasks-team-design.md §7.3, D-257): список таблиц со ссылкой на клиента и
// карточку, конфликты, заполнение пустых полей, номера, план карточек по пространствам и отпечаток предпросмотра.
// Без БД и Next: проверяется unit-тестами. Запись — merge.ts и mergeRepo.ts.
import { createHash } from 'node:crypto';

/**
 * Что слияние делает со ссылкой: `move` — строки проигравшего переходят выжившему (UPDATE), `chain` — не
 * переносятся и читаются по цепочке `merged_into_id` (D-068), `keep` — остаются как история.
 * `leftover` — законный остаток у проигравшего после `move`: карточка с задержкой `merged` или пара `merged`.
 */
export type MergeMode = 'move' | 'chain' | 'keep';
export interface MergeTableRule {
  mode: MergeMode;
  leftover?: 'merged_card' | 'merged_pair';
}

/**
 * Каждый внешний ключ на `clients(id)` и `cards(id)`: «таблица.колонка». Интеграционный тест сверяет список с
 * `pg_constraint` (PROCESS 12.20): новая ссылка без строки здесь роняет CI.
 */
export const MERGE_TABLES = {
  'clients.merged_into_id': { mode: 'chain' },
  'contacts.client_id': { mode: 'move' },
  'client_phones.client_id': { mode: 'move' },
  'import_rows.client_id': { mode: 'move' },
  'client_sources.client_id': { mode: 'move' },
  'dup_pairs.a_client_id': { mode: 'move', leftover: 'merged_pair' },
  'dup_pairs.b_client_id': { mode: 'move', leftover: 'merged_pair' },
  'consents.client_id': { mode: 'chain' },
  'change_snapshots.client_id': { mode: 'keep' },
  'cards.client_id': { mode: 'move', leftover: 'merged_card' },
  'calls.client_id': { mode: 'move' },
  'calls.card_id': { mode: 'move' },
  'assign_log.card_id': { mode: 'keep' },
  'skips.card_id': { mode: 'keep' },
  'proposals.matched_client_id': { mode: 'move' },
  'proposals.client_id': { mode: 'move' },
  'deals.client_id': { mode: 'move' },
  'deals.card_id': { mode: 'move' },
  'bookings.client_id': { mode: 'move' },
  'bookings.card_id': { mode: 'move' },
  'handoffs.client_id': { mode: 'move' },
  'tasks.client_id': { mode: 'move' },
  'notes.client_id': { mode: 'move' },
  'client_events.client_id': { mode: 'chain' },
  'messenger_chats.client_id': { mode: 'move' },
} as const satisfies Record<string, MergeTableRule>;

/** Таблицы, где строки проигравшего переходят выжившему одной колонкой `client_id` (шаг 2), в порядке записи. */
export const MOVE_CLIENT_TABLES = ['contacts', 'client_sources', 'import_rows', 'messenger_chats', 'handoffs', 'notes', 'tasks', 'deals', 'bookings', 'calls'] as const;
export type MoveClientTable = (typeof MOVE_CLIENT_TABLES)[number];

/** Счётчики переноса по таблицам (предпросмотр, ответ, аудит). */
export type MoveTable = MoveClientTable | 'proposals' | 'client_phones' | 'cards';

// ---------------------------------------------------------------------------
// Клиенты: заполнение пустых полей
// ---------------------------------------------------------------------------

export interface MergeClientRow {
  id: string;
  kind: string;
  name: string;
  legalForm: string;
  orgId: string;
  iinHmac: string | null;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: Record<string, unknown>;
  mergedIntoId: string | null;
  updatedAt: number;
}

/** Поля, которые выживший получает от проигравшего, только если у него пусто. */
export const FILL_FIELDS = ['legalForm', 'orgId', 'iinHmac', 'region', 'address', 'email', 'website', 'custom'] as const;
export type FillField = (typeof FILL_FIELDS)[number];

export interface ClientFill {
  legalForm: string;
  orgId: string;
  iinHmac: string | null;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: Record<string, unknown>;
}

/**
 * Итоговые поля выжившего: пустые (`''`, `null`) берутся у проигравшего, заполненные не трогаются; в `custom`
 * добавляются только ключи, которых у выжившего нет. `filled` — какие поля изменились (для предпросмотра).
 */
export function fillEmpty(survivor: MergeClientRow, loser: MergeClientRow): { next: ClientFill; filled: FillField[] } {
  const filled: FillField[] = [];
  const text = (f: 'legalForm' | 'orgId' | 'region' | 'address' | 'email' | 'website'): string => {
    if (survivor[f] === '' && loser[f] !== '') {
      filled.push(f);
      return loser[f];
    }
    return survivor[f];
  };
  const legalForm = text('legalForm');
  const orgId = text('orgId');
  let iinHmac = survivor.iinHmac;
  if (iinHmac === null && loser.iinHmac !== null) {
    iinHmac = loser.iinHmac;
    filled.push('iinHmac');
  }
  const region = text('region');
  const address = text('address');
  const email = text('email');
  const website = text('website');
  const missing = Object.keys(loser.custom).filter((k) => !Object.hasOwn(survivor.custom, k));
  const custom = missing.length === 0 ? survivor.custom : { ...survivor.custom, ...Object.fromEntries(missing.map((k) => [k, loser.custom[k]])) };
  if (missing.length > 0) filled.push('custom');
  return { next: { legalForm, orgId, iinHmac, region, address, email, website, custom }, filled };
}

// ---------------------------------------------------------------------------
// Номера
// ---------------------------------------------------------------------------

/** Номера проигравшего: цифры уже есть у выжившего → удалить (снимок), иначе перенести. */
export function planPhones(survivorDigits: readonly string[], loserPhones: readonly { id: string; digits: string }[]): { move: string[]; drop: string[] } {
  const have = new Set(survivorDigits);
  const move: string[] = [];
  const drop: string[] = [];
  for (const p of loserPhones) (have.has(p.digits) ? drop : move).push(p.id);
  return { move, drop };
}

// ---------------------------------------------------------------------------
// Конфликты
// ---------------------------------------------------------------------------

export type MergeConflict = 'booking_conflict' | 'other_space';

export interface MergeBookingRow {
  id: string;
  clientId: string;
  kind: 'group' | 'individual';
  eventId: string | null;
  eventTypeKey: string;
  status: string;
  startsAt: number;
}

/** Статусы, при которых групповая запись держит место (частичный уникальный индекс bookings_group_uq). */
const LIVE_GROUP = new Set(['registered', 'confirmed', 'attended', 'no_show']);
/** Активная запись (PROCESS 12.18). */
const ACTIVE = new Set(['registered', 'confirmed']);

/**
 * Записи обоих мешают слиянию: живые групповые на одно мероприятие или будущие активные одного вида
 * мероприятия (PROCESS 12.18). РОП сначала отменяет одну из них — авто-отмена была бы тихой потерей записи.
 */
export function hasBookingConflict(survivorId: string, loserId: string, bookings: readonly MergeBookingRow[], now: number): boolean {
  const side = (id: string) => bookings.filter((b) => b.clientId === id);
  const s = side(survivorId);
  const l = side(loserId);
  const events = new Set(s.filter((b) => b.kind === 'group' && b.eventId !== null && LIVE_GROUP.has(b.status)).map((b) => b.eventId));
  if (l.some((b) => b.kind === 'group' && b.eventId !== null && LIVE_GROUP.has(b.status) && events.has(b.eventId))) return true;
  const futureTypes = new Set(s.filter((b) => ACTIVE.has(b.status) && b.startsAt > now).map((b) => b.eventTypeKey));
  return l.some((b) => ACTIVE.has(b.status) && b.startsAt > now && futureTypes.has(b.eventTypeKey));
}

/** Конфликты в порядке показа; пусто — слияние разрешено. */
export function mergeConflicts(a: { hiddenCards: boolean; bookingConflict: boolean }): MergeConflict[] {
  const out: MergeConflict[] = [];
  if (a.bookingConflict) out.push('booking_conflict');
  if (a.hiddenCards) out.push('other_space');
  return out;
}

// ---------------------------------------------------------------------------
// Карточки по пространствам
// ---------------------------------------------------------------------------

export interface MergeCardRef {
  id: string;
  spaceId: string;
  clientId: string;
  version: number;
}

export interface CardsPlan {
  /** Пространства, где карточки есть у обоих: ядро `merge`, проигравшая остаётся с задержкой `merged`. */
  merge: Array<{ spaceId: string; survivorCardId: string; loserCardId: string }>;
  /** Только у проигравшего: карточка переходит выжившему целиком. */
  move: Array<{ spaceId: string; cardId: string }>;
}

export function planCards(survivorId: string, loserId: string, cards: readonly MergeCardRef[]): CardsPlan {
  const plan: CardsPlan = { merge: [], move: [] };
  const spaces = [...new Set(cards.map((c) => c.spaceId))].sort();
  for (const spaceId of spaces) {
    const s = cards.find((c) => c.spaceId === spaceId && c.clientId === survivorId);
    const l = cards.find((c) => c.spaceId === spaceId && c.clientId === loserId);
    if (s && l) plan.merge.push({ spaceId, survivorCardId: s.id, loserCardId: l.id });
    else if (l) plan.move.push({ spaceId, cardId: l.id });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Отпечаток предпросмотра
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  pairId: string;
  survivorId: string;
  ownerFrom: 'auto' | 'survivor' | 'other';
  clients: ReadonlyArray<{ id: string; updatedAt: number }>;
  cards: ReadonlyArray<{ id: string; version: number }>;
  /** id переносимых строк по таблицам. */
  rows: Readonly<Record<string, readonly string[]>>;
}

/**
 * sha256 канонического JSON: выбор РОП, id и `updated_at` клиентов, id и версии карточек, отсортированные id
 * переносимых строк. Любая правка между предпросмотром и применением меняет отпечаток → 409 `changed`.
 */
export function mergeFingerprint(i: FingerprintInput): string {
  const byId = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const rows = Object.keys(i.rows)
    .sort()
    .map((t) => [t, [...(i.rows[t] ?? [])].sort()]);
  const canonical = JSON.stringify([
    i.pairId,
    i.survivorId,
    i.ownerFrom,
    byId(i.clients).map((c) => [c.id, c.updatedAt]),
    byId(i.cards).map((c) => [c.id, c.version]),
    rows,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
