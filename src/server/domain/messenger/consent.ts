// Согласие клиента на переписку и передачу данных за рубеж (INTEGRATIONS §3.2 п. 12). Только добавление строк:
// отзыв — новая строка `revoked`. Окно чата без отметки согласия открывается с предупреждением (D-270).
import { NotFoundError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { editableClient, insertConsent, lastConsent, visibleCard } from './repo';
import { insertClientEvent } from '../cards/repo';
import type { ConsentAction } from './types';

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

/** Запись в ленту «открыт WhatsApp, шаблон X» без текста переписки (INTEGRATIONS §3.1). */
export async function recordLinkOpened(viewer: Viewer, input: { cardId: string; templateKey: string | null }): Promise<{ cardId: string }> {
  const db = await getDb();
  const card = await visibleCard(viewer, db.sql, input.cardId);
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
