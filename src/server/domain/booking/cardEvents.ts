// События записи для машины состояний карточки (docs/booking-design.md §7.1). Карточка уже заблокирована
// вызывающим; сама запись карточку не меняет (D-133).
import type { Sql } from '@/server/platform/db';
import type { BookingActor, BookingCardEvent, BookingDeps, CardPortOptions, LockedCard } from './types';

/**
 * Применить событие через порт. Отказ ядра (`stale`, `invalid_transition`, …) действие с записью не
 * откатывает: возвращается код для `booking_history.meta.card`. `forbidden` и `not_found` — ошибка
 * сборки (карточка в той же транзакции и права проверены выше), поэтому это исключение и откат.
 */
export async function noteCardEvent(deps: BookingDeps, tx: Sql, actor: BookingActor, card: LockedCard, event: BookingCardEvent, now: number, opts?: CardPortOptions): Promise<string | null> {
  const r = await deps.cards.applyBookingEvent(tx, actor, card, event, now, opts);
  if (r.status !== 'rejected') return null;
  if (r.error === 'forbidden' || r.error === 'not_found') throw new Error(`booking: порт карточки ответил ${r.error}`);
  return r.error;
}
