// Лента клиента: чтение страницы с проекцией. Запись событий — timeline/repo (только домен).
import { fields } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { encodeCursor, type Cursor } from '../clients/input';
import { FEED_FILTERS, FEED_GROUPS, groupOf, isFeedFilter, kindsOfGroups, pickData, type FeedFilter, type FeedGroup } from './kinds';
import { readFeed, selectBookingTypesByIds, selectCallsByIds, selectNotesByIds, selectTaskPrecisionByIds } from './repo';
import type { CallInfoDto, FeedRefDto, NoteDto } from './types';

export { EVENT_KINDS, FEED_FILTERS, FEED_GROUPS, groupOf, isFeedFilter, isKnownKind, type EventKind, type FeedFilter, type FeedGroup } from './kinds';
export { createNote, pinNote, type CreateNoteInput } from './notes';
export { listClientDeals } from './deals';
export { getClientSummary, pickNextStep, type SummaryCard } from './summary';
export { NOTE_MAX, PIN_LIMIT, type CallInfoDto, type FeedRefDto, type ClientSummaryDto, type DealRowDto, type NoteDto, type NextStepKind } from './types';
export { selectPinnedNotes as readPinnedNotes } from './repo';

export const FEED_LIMIT = 50;

export type FeedItem = {
  id: string;
  kind: string;
  group: FeedGroup;
  at: number;
  actor: { id: string; name: string } | null;
  refType: string;
  refId: string;
  dealId: string | null;
  data: Record<string, unknown>;
  /** Сообщение мессенджера: текст (null — вложение без подписи или удалено), удалено ли, статус доставки. */
  message?: { text: string | null; deleted: boolean; status: string | null };
  /** Заметка события `note.created` (текст берётся из notes при чтении). */
  note: NoteDto | null;
  /** Звонок (`call`): причина, срок перезвона, текст заметки; `null` — вид другой, звонок отменён или не виден. */
  call: CallInfoDto | null;
  /** Вид мероприятия записи (`booking.status`) или точность срока задачи (`task.created`). */
  ref: FeedRefDto | null;
};

export type FeedPage = { items: FeedItem[]; next: string | null };

export type FeedOptions = {
  cursor: Cursor | null;
  groups: readonly FeedGroup[] | null;
  /** Фильтр «История правок» (вместо групп). */
  filter?: FeedFilter | null;
  /** Только события этой сделки; сделку вызывающий уже проверил. */
  dealId?: string | null;
  /** Размер страницы (превью ленты: 1–20, проверяет вызывающий); без значения — FEED_LIMIT. */
  limit?: number | null;
  /** Поля настроек и сотрудник для проверки видимости «было → стало». */
  fields: readonly fields.FieldDef[];
  fieldViewer: fields.FieldViewer;
};

/**
 * Страница ленты. Клиент должен быть уже проверен вызывающим (карточка видна). Событие скрытого поля
 * режется в SQL (не занимает лимит) и перепроверяется здесь вторым рубежом.
 */
export async function listFeed(viewer: Viewer, clientId: string, opts: FeedOptions): Promise<FeedPage> {
  const db = await getDb();
  const size = opts.limit ?? FEED_LIMIT;
  const rows = await readFeed(db.sql, viewer, {
    clientId,
    kinds: opts.filter ? [...FEED_FILTERS[opts.filter]] : kindsOfGroups(opts.groups),
    dealId: opts.dealId ?? null,
    visibleRefs: fields.visibleFieldRefs(opts.fieldViewer, opts.fields),
    cursor: opts.cursor,
    limit: size,
  });
  const more = rows.length > size;
  const page = rows.slice(0, size);
  const noteIds = page.filter((r) => r.kind === 'note.created' && r.refType === 'note').map((r) => r.refId);
  const notes = new Map((await selectNotesByIds(db.sql, viewer, noteIds)).map((n) => [n.id, n]));
  const calls = await selectCallsByIds(db.sql, viewer, page.filter((r) => r.kind === 'call' && r.refType === 'call').map((r) => r.refId));
  const bookingTypes = await selectBookingTypesByIds(db.sql, viewer, page.filter((r) => r.kind === 'booking.status' && r.refType === 'booking').map((r) => r.refId));
  const taskDue = await selectTaskPrecisionByIds(db.sql, viewer, page.filter((r) => r.kind === 'task.created' && r.refType === 'task').map((r) => r.refId));
  const items: FeedItem[] = [];
  for (const r of page) {
    const group = groupOf(r.kind);
    if (!group) continue;
    const data = pickData(r.kind, r.data);
    if (r.kind === 'field.changed') {
      const d = data as { obj?: unknown; sys?: unknown; field?: unknown };
      if (typeof d.obj !== 'string' || typeof d.field !== 'string') continue;
      if (!fields.canSeeFieldChange(opts.fieldViewer, opts.fields, { obj: d.obj as fields.FieldObject, sys: d.sys === true, field: d.field })) continue;
    }
    items.push({
      id: r.id,
      kind: r.kind,
      group,
      at: r.at,
      actor: r.actorId ? { id: r.actorId, name: r.actorName ?? '' } : null,
      refType: r.refType,
      refId: r.refId,
      dealId: r.dealId,
      data,
      ...(r.kind === 'message' ? { message: { text: r.text, deleted: r.deleted, status: r.deliveryStatus } } : {}),
      note: r.kind === 'note.created' ? (notes.get(r.refId) ?? null) : null,
      call: r.kind === 'call' ? (calls.get(r.refId) ?? null) : null,
      ref: r.kind === 'booking.status' ? (bookingTypes.get(r.refId) ?? null) : r.kind === 'task.created' ? (taskDue.get(r.refId) ?? null) : null,
    });
  }
  const last = page[page.length - 1];
  return { items, next: more && last ? encodeCursor({ at: last.at, id: last.id }) : null };
}

export function parseGroups(raw: string | null): FeedGroup[] | null {
  if (!raw) return null;
  const parts = raw.split(',').filter(Boolean);
  const ok = new Set<string>(FEED_GROUPS);
  if (parts.some((p) => !ok.has(p))) throw new BadRequestError('groups');
  return [...new Set(parts)] as FeedGroup[];
}

/** Разбор `group=edits` (единственный фильтр, не являющийся группой); мусор — 400. */
export function parseFilter(raw: string | null): FeedFilter | null {
  if (!raw) return null;
  if (!isFeedFilter(raw)) throw new BadRequestError('group');
  return raw;
}
