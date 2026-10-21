// Эффекты записей для исполнителя эффектов карточки (C5, C6b, B9a): `cancel_future` и `reassign_future`.
// Событий карточки они не порождают: их уже применил вызывающий переход (docs/booking-design.md §7.2).
// Карточку заблокировал и проверил вызывающий, поэтому записи берутся по клиенту и пространству, а не по охвату.
// Отменённая консультация освобождает слот так же, как ручная отмена (docs/deals-handoffs-design.md §4.6, D-301):
// резерв повышается, задача «Назначьте консультанта» закрывается. Порядок блокировок D-251: карточка (вызывающий) →
// дни консультаций в порядке дат → записи.
import { closeAutoTaskByKey } from '@/server/domain/tasks/auto';
import type { Sql } from '@/server/platform/db';
import { lockConsultDays } from './consultDay';
import { greyTaskKey, promoteReserve } from './reserve';
import { actorUserId, cancelBookingRows, insertFeed, insertHistory, listFutureIndividualDays, lockFutureActiveBookings, reassignBookings } from './repo';
import type { ApplyBookingEffects, BookingActor } from './types';

/**
 * Дни будущих консультаций клиента под блокировкой — до блокировки записей и до сделок (D-251). Вызывает и
 * исполнитель эффектов, и сервис, который сам блокирует сделку раньше события карточки (проигрыш, D-301):
 * повторная блокировка того же дня в транзакции ничего не ждёт.
 */
export async function lockClientConsultDays(tx: Sql, a: { spaceId: string; clientId: string; after: number }): Promise<void> {
  const days = await listFutureIndividualDays(tx, a);
  if (days.length > 0) await lockConsultDays(tx, a.spaceId, days);
}

export const applyBookingEffects: ApplyBookingEffects = async (tx, actor, card, effects, at) => {
  if (effects.some((e) => e.op === 'cancel_future')) await lockClientConsultDays(tx, { spaceId: card.spaceId, clientId: card.clientId, after: at });
  for (const e of effects) {
    // Список перечитываем на каждый эффект: предыдущий мог изменить набор активных записей.
    const rows = await lockFutureActiveBookings(tx, { spaceId: card.spaceId, clientId: card.clientId, after: at });
    if (rows.length === 0) continue;
    const ids = rows.map((b) => b.id);
    if (e.op === 'cancel_future') {
      await cancelBookingRows(tx, ids, e.reason, at);
      for (const b of rows) {
        await insertHistory(tx, { bookingId: b.id, action: 'cancelled', from: b.status, to: 'cancelled', actorId: actorUserId(actor), meta: { reason: e.reason, via: 'card_effect' }, at });
        await insertFeed(tx, {
          clientId: b.clientId,
          spaceId: b.spaceId,
          dealId: b.dealId,
          kind: 'booking.status',
          actorId: actorUserId(actor),
          bookingId: b.id,
          at,
          data: { bookingId: b.id, from: b.status, to: 'cancelled', reason: e.reason },
        });
      }
      await releaseConsultSlots(tx, actor, rows, at);
    } else {
      // Заслуга (`booked_by_user_id`) не трогается: меняется только ответственный (D-042).
      await reassignBookings(tx, ids, e.to, at);
    }
  }
};

/** Отменённые консультации: задача «Назначьте консультанта» не нужна, слот консультанта отдаёт место резерву. */
async function releaseConsultSlots(
  tx: Sql,
  actor: BookingActor,
  rows: ReadonlyArray<{ id: string; kind: string; spaceId: string; resourceId: string | null; bookingDate: string; startTime: string; durationMin: number }>,
  at: number,
): Promise<void> {
  for (const b of rows) {
    if (b.kind !== 'individual') continue;
    await closeAutoTaskByKey(tx, actor, { sourceKey: greyTaskKey(b.id), at });
    if (b.resourceId) await promoteReserve(tx, actor, { spaceId: b.spaceId, resourceId: b.resourceId, date: b.bookingDate, startTime: b.startTime, durationMin: b.durationMin, at });
  }
}
