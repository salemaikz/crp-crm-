// Лента клиента: чтение страницы с проекцией. Запись событий — timeline/repo (только домен).
import { fields } from '@crm/core';
import { BadRequestError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { encodeCursor, type Cursor } from '../clients/input';
import { FEED_GROUPS, groupOf, kindsOfGroups, pickData, type FeedGroup } from './kinds';
import { readFeed } from './repo';

export { EVENT_KINDS, FEED_GROUPS, groupOf, isKnownKind, type EventKind, type FeedGroup } from './kinds';

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
};

export type FeedPage = { items: FeedItem[]; next: string | null };

export type FeedOptions = {
  cursor: Cursor | null;
  groups: readonly FeedGroup[] | null;
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
  const rows = await readFeed(db.sql, viewer, {
    clientId,
    kinds: kindsOfGroups(opts.groups),
    visibleRefs: fields.visibleFieldRefs(opts.fieldViewer, opts.fields),
    cursor: opts.cursor,
    limit: FEED_LIMIT,
  });
  const more = rows.length > FEED_LIMIT;
  const page = rows.slice(0, FEED_LIMIT);
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
