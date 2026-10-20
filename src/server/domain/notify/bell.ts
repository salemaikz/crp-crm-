// Колокол пользователя: список, счётчик для бейджа оболочки, «прочитано». Только свои строки (user_id из Viewer).
import type { Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { countUnread, listForUser, markRead } from './repo';
import type { NotificationPage } from './types';

export const BELL_PAGE_SIZE = 30;
export const BELL_MAX_PAGE = 100;

/** Число непрочитанных для `RoleShell bellCount`. Не бросает: бейдж не должен ронять страницу. */
export async function unreadCount(viewer: Viewer): Promise<number> {
  try {
    return await countUnread((await getDb()).sql, viewer.userId);
  } catch {
    return 0;
  }
}

/** Страница уведомлений, новые сверху; курсор — `created_at` последней строки. */
export async function listMine(viewer: Viewer, opts: { cursor?: string | null; limit?: number } = {}): Promise<NotificationPage> {
  const limit = Math.min(Math.max(opts.limit ?? BELL_PAGE_SIZE, 1), BELL_MAX_PAGE);
  const before = opts.cursor && /^\d{1,16}$/.test(opts.cursor) ? Number(opts.cursor) : null;
  const db = await getDb();
  const rows = await listForUser(db.sql, { userId: viewer.userId, before, limit: limit + 1 });
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    unread: await countUnread(db.sql, viewer.userId),
    next: rows.length > limit && last ? String(last.createdAt) : null,
  };
}

/** Отметить прочитанными свои уведомления: `ids` = null — все. Чужие id молча пропускаются. */
export async function markMineRead(viewer: Viewer, ids: readonly string[] | null): Promise<{ marked: number; unread: number }> {
  const db = await getDb();
  const marked = await markRead(db.sql, { userId: viewer.userId, ids, now: viewer.now });
  return { marked, unread: await countUnread(db.sql, viewer.userId) };
}
