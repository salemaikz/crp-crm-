// Сервер доски оператора (docs/pipeline-v2-design.md §2.3, §6.2, §9.4): колонки с ключевой пагинацией, поиск по своим,
// фильтры. Колонка вычисляется ядром (`calling.columnOf`), а не хранится. Охват — в SQL каждого запроса (boardRepo).
// Клиенту уходят только поля плитки (`showOn.kanban`) и признаки покупок при `deal.read` с охватом роли.
import { calling, fields } from '@crm/core';
import { z } from 'zod';
import { BadRequestError, NotFoundError, type Viewer } from '@/server/access';
import type { Scope } from '@crm/core/access';
import { dueBoundsAt } from '@/server/domain/calls/dueBounds';
import { queueLprs, queuePhones } from '@/server/domain/calls/repo';
import { maskKzPhone } from '@/shared/tel';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from '@/server/domain/clients';
import { ConfigMissingError } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import { getDb } from '@/server/platform/db';
import { loadBoardSettings, type BoardColumnInfo, type BoardSettings } from './boardSettings';
import { selectBoardRows, selectColumnKeys, selectSearchIds, type BoardFilters, type BoardRowDb, type ColumnKind, type KeyCursor, type KeyRow } from './boardRepo';
import { loadCallingContext } from './settings';

/** Карточек в колонке за один запрос и в результате поиска (PROCESS 8.3). */
export const BOARD_PAGE = 50;
export const BOARD_SEARCH_LIMIT = 20;

const FILTER_KEYS = ['today', 'attendedGroup', 'attendedIndividual', 'noShow', 'purchased', 'attendedNoBuy'] as const;
export type BoardFilterKey = (typeof FILTER_KEYS)[number];

export interface BoardQuery {
  /** Строка поиска: название от 3 символов, номер от 5 цифр. */
  q?: string | null;
  filter?: readonly string[];
  owner?: string | null;
  callbackReason?: string | null;
}

export interface BoardColumnQuery extends BoardQuery {
  column: string;
  cursor?: string | null;
}

export interface BoardCardDto {
  id: string;
  clientId: string;
  name: string;
  state: string;
  version: number;
  /** Колонка доски; null — карточки на доске нет (задержана, в пуле), её нашёл поиск. */
  column: string | null;
  nextCallAt: number | null;
  nextCallPrecision: 'time' | 'day';
  fire: 'overdue' | 'today' | null;
  callbackReason: string;
  callbackTouches: number;
  attempts: number;
  lpr: string;
  isTarget: string;
  /** Имя ЛПР (первый контакт с признаком «принимает решения»); пусто — контакта нет. */
  lprName: string;
  /**
   * Основной рабочий номер не из стоп-листа. Закрытый вид — для плитки; цифры (`digits`) уходят только при охвате `own`
   * (оператору на его карточках, как в очереди «Звонить»): РОП и директор на плитках цифр не получают.
   */
  phone: { id: string; masked: string; kind: 'mobile' | 'landline' | 'unknown'; digits?: string } | null;
  /**
   * Имя владельца карточки (ответственный) — только при охвате шире своих (РОП, директор); у оператора ключа нет вовсе,
   * а не пустая строка. Карточка без владельца ключа не имеет.
   */
  ownerName?: string;
  flags: { attendedGroup: boolean; attendedIndividual: boolean; noShow: boolean };
  /**
   * Только при `deal.read` с охватом роли: у остальных ключа нет, а не нули. `lastAmountKzt` — сумма последней покупки
   * (для строки колонки «Покупка»), целые тенге; null — суммы нет.
   */
  purchases?: { total: number; lastAt: number | null; lastAmountKzt: number | null };
  /** Запись открытой сделки (для «Договорились»). */
  event: { type: string; status: string; startsAt: number; bookingId: string; bookingVersion: number } | null;
  closedAt: number | null;
  closeReasonCode: string;
  values: Record<string, fields.FieldValue>;
}

export interface BoardColumnDto {
  key: string;
  label: string | null;
  states: readonly string[];
  cards: BoardCardDto[];
  /** Курсор «Ещё»; null — карточки закончились. */
  next: string | null;
}

export interface BoardDto {
  columns: BoardColumnDto[];
  tones: readonly { when: string; tone: string }[];
  /** Можно ли фильтровать по владельцу (охват шире своих). */
  canFilterOwner: boolean;
  /** Поиск: совпадения среди своих карточек; `short` — запрос слишком короткий. */
  search?: { matches: BoardCardDto[]; short: boolean };
}

export interface BoardColumnPage {
  key: string;
  cards: BoardCardDto[];
  next: string | null;
}

// ---------- Доступ ----------

interface Access {
  spaceId: string;
  scope: Scope;
  /** `deal.read` дан самой ролью (без отношений, D-300). */
  purchases: boolean;
}

/**
 * Доска доступна при `card.outcome` (оператор, РОП) или `report.view` с охватом пространства (директор, только чтение).
 * Остальным — 404, как и при выключенном `OP_BOARD`: модуля для них нет (D-017).
 */
function boardAccess(viewer: Viewer): Access {
  if (!isFeatureEnabled('OP_BOARD')) throw new NotFoundError();
  const scope = viewer.grants.get('card.read');
  const report = viewer.grants.get('report.view');
  const wide = report === 'space' || report === 'all';
  if (viewer.spaceId === null || !scope || !(viewer.grants.has('card.outcome') || wide)) throw new NotFoundError();
  return { spaceId: viewer.spaceId, scope, purchases: viewer.grants.has('deal.read') };
}

function parseFilters(q: BoardQuery, access: Access): BoardFilters {
  const set = new Set<string>();
  for (const f of q.filter ?? []) {
    if (!(FILTER_KEYS as readonly string[]).includes(f)) throw new BadRequestError('filter');
    set.add(f);
  }
  // Признаки покупок скрыты от роли без `deal.read`: фильтр по ним — тоже 400 (PROCESS 8.3)
  if ((set.has('purchased') || set.has('attendedNoBuy')) && !access.purchases) throw new BadRequestError('filter');
  const owner = q.owner && q.owner !== '' ? q.owner : null;
  if (owner !== null && access.scope === 'own') throw new BadRequestError('owner');
  const reason = q.callbackReason && q.callbackReason !== '' ? q.callbackReason : null;
  if (reason !== null && reason.length > 100) throw new BadRequestError('callback_reason');
  return {
    owner,
    today: set.has('today'),
    attendedGroup: set.has('attendedGroup'),
    attendedIndividual: set.has('attendedIndividual'),
    noShow: set.has('noShow'),
    purchased: set.has('purchased'),
    attendedNoBuy: set.has('attendedNoBuy'),
    callbackReason: reason,
  };
}

// ---------- Курсор ----------

const Cursor = z.object({ p: z.union([z.literal(0), z.literal(1)]), a: z.number().finite(), b: z.number().finite(), c: z.number().finite(), i: z.string().max(100) }).strict();

export function encodeCursor(k: KeyCursor): string {
  return Buffer.from(JSON.stringify({ p: k.part, a: k.k1, b: k.k2, c: k.k3, i: k.id })).toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): KeyCursor | null {
  if (!raw) return null;
  try {
    const p = Cursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { part: p.p, k1: p.a, k2: p.b, k3: p.c, id: p.i };
  } catch {
    throw new BadRequestError('cursor');
  }
}

// ---------- Колонки ----------

const CLOSED = ['not_interested', 'not_target', 'do_not_call', 'written_off'];

/** Вид колонки по её состояниям (§2.1): от него зависят условие и порядок. */
export function kindOfColumn(def: calling.BoardColumnDef): ColumnKind {
  const s = def.states as readonly string[];
  if (s.includes('agreed')) return 'agreed';
  if (s.includes('client')) return 'client';
  if (s.some((x) => CLOSED.includes(x))) return 'closed';
  if (s.includes('retry') || s.includes('callback')) return 'callback';
  return 'new';
}

const DAY_MS = 86_400_000;

function agreedOf(settings: BoardSettings, def: calling.BoardColumnDef): { types: string[]; allTypes: string[]; fallback: boolean } {
  const agreedCols = settings.spec.columns.filter((c) => c.states.includes('agreed'));
  const allTypes = [...new Set(agreedCols.flatMap((c) => [...(c.eventTypes ?? [])]))];
  // Колонка по умолчанию — та же, что выбирает ядро для «Договорились» без подходящей записи
  const fallbackKey = calling.columnOf(
    { state: 'agreed', holdReason: '', ownerUserId: 'x', attempts: 0, closedAt: null },
    null,
    settings.spec,
  );
  return { types: [...(def.eventTypes ?? [])], allTypes, fallback: fallbackKey === def.key };
}

interface Ctx {
  access: Access;
  settings: BoardSettings;
  cfg: ClientsConfig | null;
  bounds: calling.DueBounds;
  now: number;
}

async function configOrNull(viewer: Viewer): Promise<ClientsConfig | null> {
  try {
    return await loadClientsConfig(viewer);
  } catch (e) {
    if (e instanceof ConfigMissingError) return null;
    throw e;
  }
}

async function buildCtx(viewer: Viewer): Promise<Ctx> {
  const access = boardAccess(viewer);
  const now = viewer.now;
  const [settings, cc, cfg] = await Promise.all([loadBoardSettings(access.spaceId), loadCallingContext(access.spaceId, now), configOrNull(viewer)]);
  return { access, settings, cfg, bounds: dueBoundsAt(now, cc.overdueAlertMinutes, cc.calendar), now };
}

// ---------- Плитка ----------

/** Имя ответственного видят все охваты, кроме «своих» (у оператора плитка и так его): team, space, all. */
export function showsOwner(scope: Scope): boolean {
  return scope !== 'own';
}

function tileValues(cfg: ClientsConfig | null, viewer: Viewer, r: BoardRowDb): Record<string, fields.FieldValue> {
  if (!cfg) return {};
  const fv = fieldViewer(viewer, cfg);
  const out: Record<string, fields.FieldValue> = {};
  for (const object of ['client', 'card'] as const) {
    const onTile = new Set(cfg.fields.filter((f) => f.object === object && f.showOn.kanban).map((f) => f.key));
    const visible = fields.projectValues(fv, object, cfg.fields, (object === 'client' ? r.clientCustom : r.cardCustom) as fields.CustomValues);
    for (const [k, v] of Object.entries(visible)) if (onTile.has(k)) out[k] = v;
  }
  return out;
}

/** Номер и ЛПР для плиток страницы: один запрос на страницу, клиенты уже отобраны под охватом. */
interface Extras {
  phones: Map<string, { id: string; digits: string; kind: 'mobile' | 'landline' | 'unknown' }>;
  lprs: Map<string, string>;
}

async function loadExtras(rows: readonly BoardRowDb[]): Promise<Extras> {
  const db = await getDb();
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const [phoneRows, lprRows] = await Promise.all([queuePhones(db.sql, clientIds), queueLprs(db.sql, clientIds)]);
  const phones = new Map<string, { id: string; digits: string; kind: 'mobile' | 'landline' | 'unknown' }>();
  // Номера приходят в порядке «основной, мобильный, старший»: первый на клиента и есть номер плитки
  for (const p of phoneRows) if (!phones.has(p.clientId)) phones.set(p.clientId, { id: p.id, digits: p.digits, kind: p.kind });
  return { phones, lprs: new Map(lprRows.map((l) => [l.clientId, l.name])) };
}

function toDto(viewer: Viewer, c: Ctx, r: BoardRowDb, column: string | null, x: Extras): BoardCardDto {
  const ph = x.phones.get(r.clientId);
  const lastAttended = Math.max(r.attendedGroupAt ?? -Infinity, r.attendedIndividualAt ?? -Infinity);
  const working = r.state === 'retry' || r.state === 'callback';
  return {
    id: r.id,
    clientId: r.clientId,
    name: r.name,
    state: r.state,
    version: r.version,
    column,
    nextCallAt: r.nextCallAt,
    nextCallPrecision: r.nextCallPrecision,
    fire: working ? calling.fireOf(r.nextCallAt, r.nextCallPrecision, c.bounds) : null,
    callbackReason: r.callbackReason,
    callbackTouches: r.callbackTouches,
    attempts: r.attempts,
    lpr: r.lpr,
    isTarget: r.isTarget,
    lprName: x.lprs.get(r.clientId) ?? '',
    phone: ph ? { id: ph.id, masked: maskKzPhone(ph.digits), kind: ph.kind, ...(c.access.scope === 'own' ? { digits: ph.digits } : {}) } : null,
    ...(showsOwner(c.access.scope) && r.ownerName !== null && r.ownerName !== '' ? { ownerName: r.ownerName } : {}),
    flags: {
      attendedGroup: r.attendedGroupAt !== null,
      attendedIndividual: r.attendedIndividualAt !== null,
      noShow: r.lastNoShowAt !== null && r.lastNoShowAt > lastAttended,
    },
    ...(c.access.purchases ? { purchases: { total: r.purchasesTotal, lastAt: r.lastPurchaseAmount !== null ? (r.lastPurchaseWonAt === null ? null : Number(r.lastPurchaseWonAt)) : r.lastPurchaseAt, lastAmountKzt: r.lastPurchaseAmount === null ? null : Number(r.lastPurchaseAmount) } } : {}),
    event:
      r.bookingType !== null && r.bookingStatus !== null && r.bookingStartsAt !== null && r.bookingId !== null && r.bookingVersion !== null
        ? { type: r.bookingType, status: r.bookingStatus, startsAt: r.bookingStartsAt, bookingId: r.bookingId, bookingVersion: Number(r.bookingVersion) }
        : null,
    closedAt: r.closedAt,
    closeReasonCode: r.closeReasonCode,
    values: tileValues(c.cfg, viewer, r),
  };
}

/** Колонка карточки для поиска: то же правило ядра, что и у выборки колонок. */
function columnForSearch(c: Ctx, r: BoardRowDb): string | null {
  const booking = r.bookingType !== null && r.bookingStatus !== null ? { eventType: r.bookingType, status: r.bookingStatus, dealIsOpen: true } : null;
  return calling.columnOf({ state: r.state as calling.CardState, holdReason: r.holdReason as calling.CardSnapshot['holdReason'], ownerUserId: r.ownerUserId, attempts: r.attempts, closedAt: r.closedAt }, booking, c.settings.spec);
}

async function loadColumn(viewer: Viewer, c: Ctx, info: BoardColumnInfo, cursor: KeyCursor | null, filters: BoardFilters): Promise<BoardColumnPage> {
  const db = await getDb();
  const def = info.def;
  const kind = kindOfColumn(def);
  const keys: KeyRow[] = await selectColumnKeys(db.sql, viewer, {
    spaceId: c.access.spaceId,
    kind,
    states: def.states,
    agreed: agreedOf(c.settings, def),
    closedFrom: kind === 'closed' && def.recentDays !== undefined ? c.now - def.recentDays * DAY_MS : null,
    bounds: c.bounds,
    mobileFirst: c.access.scope === 'own',
    wide: c.access.scope === 'space' || c.access.scope === 'all',
    cursor,
    limit: BOARD_PAGE + 1,
    filters,
  });
  const page = keys.slice(0, BOARD_PAGE);
  const last = page[page.length - 1];
  const rows = await selectBoardRows(db.sql, viewer, page.map((k) => k.id));
  const x = await loadExtras(rows);
  return {
    key: info.key,
    cards: rows.map((r) => toDto(viewer, c, r, info.key, x)),
    next: keys.length > BOARD_PAGE && last ? encodeCursor({ part: last.part, k1: last.k1, k2: last.k2, k3: last.k3, id: last.id }) : null,
  };
}

async function search(viewer: Viewer, c: Ctx, q: string): Promise<{ matches: BoardCardDto[]; short: boolean } | null> {
  const parsed = fields.parseSearchQuery(q);
  if (parsed.kind === 'none') return null;
  if (parsed.kind === 'short') return { matches: [], short: true };
  const p1 = parsed.patterns[0] ?? '';
  const db = await getDb();
  const ids = await selectSearchIds(db.sql, viewer, { spaceId: c.access.spaceId, p1, p2: parsed.patterns[1] ?? p1, limit: BOARD_SEARCH_LIMIT });
  const rows = await selectBoardRows(db.sql, viewer, ids);
  const x = await loadExtras(rows);
  return { matches: rows.map((r) => toDto(viewer, c, r, columnForSearch(c, r), x)), short: false };
}

/** Доска: первая страница каждой колонки, поиск при непустом `q`. */
export async function getBoard(viewer: Viewer, q: BoardQuery): Promise<BoardDto> {
  const c = await buildCtx(viewer);
  const filters = parseFilters(q, c.access);
  const [pages, found] = await Promise.all([
    Promise.all(c.settings.columns.map((info) => loadColumn(viewer, c, info, null, filters))),
    q.q ? search(viewer, c, q.q) : Promise.resolve(null),
  ]);
  return {
    columns: c.settings.columns.map((info, i) => ({ key: info.key, label: info.label, states: info.def.states, cards: pages[i]!.cards, next: pages[i]!.next })),
    tones: c.settings.tones,
    canFilterOwner: c.access.scope !== 'own',
    ...(found ? { search: found } : {}),
  };
}

/** «Ещё» по ключу: следующая страница колонки после курсора. */
export async function getBoardColumn(viewer: Viewer, q: BoardColumnQuery): Promise<BoardColumnPage> {
  const c = await buildCtx(viewer);
  const filters = parseFilters(q, c.access);
  const info = c.settings.columns.find((x) => x.key === q.column);
  if (!info) throw new BadRequestError('column');
  return loadColumn(viewer, c, info, decodeCursor(q.cursor), filters);
}
