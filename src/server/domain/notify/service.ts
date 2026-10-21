// Сервис уведомлений для соседних модулей домена: репозиторий (repo.ts) наружу не выходит.
import type { Sql } from '@/server/platform/db';
import { insertNotifications, listRecipients } from './repo';

/**
 * Одно событие — уведомление каждому получателю: сотрудникам пространства с указанными ролями и дополнительным
 * пользователям. Без параметров (ПДн не попадают в текст); повтор по `dedupeKey` ничего не задваивает.
 * Работает в переданной транзакции.
 */
export async function notifyRoles(
  sql: Sql,
  a: { spaceId: string; roles: readonly string[]; extraUserIds?: readonly string[]; kind: string; eventId: string; newId: () => string; now: number },
): Promise<number> {
  const recipients = new Set([...(await listRecipients(sql, { spaceId: a.spaceId, roles: a.roles })), ...(a.extraUserIds ?? [])]);
  return insertNotifications(sql, {
    rows: [...recipients].map((userId) => ({ id: a.newId(), userId, kind: a.kind, params: {}, dedupeKey: `${a.eventId}:${userId}` })),
    mode: 'ignore',
    now: a.now,
  });
}
