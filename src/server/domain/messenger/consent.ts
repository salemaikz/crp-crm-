// Согласие клиента на переписку и передачу данных за рубеж (INTEGRATIONS §3.2 п. 12). Только добавление строк:
// отзыв — новая строка `revoked`. Окно чата без отметки согласия открывается с предупреждением (D-270).
import { NotFoundError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { rateLimit } from '@/server/platform/ratelimit';
import { editableClient, insertConsent, lastConsent, visibleCard } from './repo';
import { insertClientEvent } from '../cards/repo';
import { ChatWindowError, type ConsentAction } from './types';

/** Отметок «открыт WhatsApp» в минуту на сотрудника: защита ленты клиента от залива (D-297). */
export const LINK_OPENED_RATE = 20;

export async function setMessengerConsent(viewer: Viewer, input: { clientId: string; action: ConsentAction; textHash: string; now?: number }): Promise<{ clientId: string; action: ConsentAction }> {
  const db = await getDb();
  const client = await editableClient(viewer, db.sql, input.clientId);
  if (!client) throw new NotFoundError();
  await insertConsent(db.sql, { clientId: client.id, action: input.action, textHash: input.textHash, recordedBy: viewer.userId, at: input.now ?? viewer.now });
  return { clientId: client.id, action: input.action };
}

/** Текущее состояние отметки для переключателя в карточке: `given`, `revoked` или null (не отмечено). */
export async function getMessengerConsent(viewer: Viewer, clientId: string): Promise<'given' | 'revoked' | null> {
  return lastConsent(viewer, (await getDb()).sql, clientId);
}

/**
 * Запись в ленту «открыт WhatsApp, шаблон X» без текста переписки (INTEGRATIONS §3.1). Пишущее действие (`note.write`,
 * D-297): «только чтение» и запирающая лицензия получают 423 в обёртке; не больше LINK_OPENED_RATE в минуту на сотрудника.
 */
export async function recordLinkOpened(viewer: Viewer, input: { cardId: string; templateKey: string | null }): Promise<{ cardId: string }> {
  if (!rateLimit(`waopened:${viewer.userId}`, LINK_OPENED_RATE, 60_000, viewer.now).ok) throw new ChatWindowError('rate_limited');
  const db = await getDb();
  const card = await visibleCard(viewer, db.sql, input.cardId, 'note.write');
  if (!card || viewer.spaceId === null) throw new NotFoundError();
  await insertClientEvent(db.sql, {
    clientId: card.clientId,
    spaceId: card.spaceId,
    kind: 'messenger.link_opened',
    actorId: viewer.userId,
    at: viewer.now,
    refType: '',
    refId: '',
    data: { templateKey: input.templateKey },
  });
  return { cardId: card.id };
}
