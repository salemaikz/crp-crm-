// Набор блокировок применения «Записей» (D-251, docs/import-bookings-design.md §8.2 п. 6–7): что заблокировано до
// пересчёта и покрывает ли это всё, что пересчёт увидел. Чистые функции без БД.
import type { BookingInputs } from './bookingLoad';

export interface LockedSet {
  cardIds: readonly string[];
  /** Карточки напарников спорных пар: не меняются, но решение строки от них зависит (PROCESS 7.6). */
  partnerCardIds: readonly string[];
  eventIds: readonly string[];
  clientIds: readonly string[];
}

/** Что блокировать по входам, прочитанным до блокировок. */
export function lockSetOf(pre: Pick<BookingInputs, 'candidates' | 'events' | 'partnerCards'>): LockedSet {
  return {
    cardIds: pre.candidates.map((c) => c.cardId),
    partnerCardIds: pre.partnerCards.map((c) => c.cardId),
    eventIds: pre.events.map((e) => e.id),
    clientIds: pre.candidates.map((c) => c.clientId),
  };
}

/**
 * Пересчёт под блокировками видит только заблокированное? Карточка (в том числе напарника новой пары) или мероприятие, появившиеся между первым чтением
 * и блокировкой (передача, ручное создание), не заблокированы: применение по ним нарушило бы порядок D-251, поэтому
 * такой заход заканчивается `preview_stale`, а следующий заблокирует их по порядку.
 */
export function lockCovers(locked: LockedSet, comp: Pick<BookingInputs, 'candidates' | 'events' | 'partnerCards'>): boolean {
  const cards = new Set(locked.cardIds);
  const partners = new Set([...locked.cardIds, ...locked.partnerCardIds]);
  const events = new Set(locked.eventIds);
  const clients = new Set(locked.clientIds);
  return (
    comp.candidates.every((c) => cards.has(c.cardId) && clients.has(c.clientId)) &&
    comp.events.every((e) => events.has(e.id)) &&
    comp.partnerCards.every((c) => partners.has(c.cardId))
  );
}
