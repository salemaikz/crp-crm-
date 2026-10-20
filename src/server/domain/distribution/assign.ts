// Строки выдачи пакетом (docs/distribution-design.md §3.3). Чистая функция: ни БД, ни часов.
// Смысл перехода № 2 ядра `calling` (событие `assign`) здесь повторён пакетом: владелец, assigned_at, версия + 1,
// `touched_in_crm` не трогаем (D-145); вид и вхождение в лимит в журнале, событие ленты `card.assigned`,
// сводное уведомление `cards_assigned` с ключом `assign:<runId>:<user>`. Паритет с ядром проверяет unit-тест (D-173).
import { newId } from '@/server/platform/db';
import type { AssignBatch } from './types';

export interface AssignLogRow {
  id: string;
  cardId: string;
  toUserId: string;
  kind: AssignBatch['kind'];
  countsToCap: boolean;
}

export interface AssignEventRow {
  id: string;
  clientId: string;
  /** Данные события ленты: коды и id, без ПДн. */
  data: { toUserId: string; mode: AssignBatch['kind'] };
}

export interface AssignNotificationRow {
  id: string;
  userId: string;
  kind: 'cards_assigned';
  count: number;
  dedupeKey: string;
}

export interface AssignRowsResult {
  /** userId владельца по id карточки. */
  owners: { cardId: string; ownerUserId: string }[];
  log: AssignLogRow[];
  events: AssignEventRow[];
  notifications: AssignNotificationRow[];
}

/**
 * Строки записи для карточек, которые реально сменили владельца. `assigned` — userId → id карточек;
 * `clientIdOf` — клиент каждой карточки (для ленты).
 */
export function assignRows(
  batch: Pick<AssignBatch, 'runId' | 'kind' | 'countsToCap'>,
  assigned: Readonly<Record<string, readonly string[]>>,
  clientIdOf: ReadonlyMap<string, string>,
  makeId: () => string = newId,
): AssignRowsResult {
  const out: AssignRowsResult = { owners: [], log: [], events: [], notifications: [] };
  for (const userId of Object.keys(assigned).sort()) {
    const cards = assigned[userId] ?? [];
    if (cards.length === 0) continue;
    for (const cardId of cards) {
      const clientId = clientIdOf.get(cardId);
      if (clientId === undefined) throw new Error('assignRows: нет клиента карточки');
      out.owners.push({ cardId, ownerUserId: userId });
      out.log.push({ id: makeId(), cardId, toUserId: userId, kind: batch.kind, countsToCap: batch.countsToCap });
      out.events.push({ id: makeId(), clientId, data: { toUserId: userId, mode: batch.kind } });
    }
    out.notifications.push({ id: makeId(), userId, kind: 'cards_assigned', count: cards.length, dedupeKey: `assign:${batch.runId}:${userId}` });
  }
  return out;
}
