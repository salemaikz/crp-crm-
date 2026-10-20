// Эффекты записей для исполнителя эффектов карточки (C5, C6b, B9a): `cancel_future` и `reassign_future`.
// Событий карточки они не порождают: их уже применил вызывающий переход (docs/booking-design.md §7.2).
// Карточку заблокировал и проверил вызывающий, поэтому записи берутся по клиенту и пространству, а не по охвату.
import { actorUserId, cancelBookingRows, insertFeed, insertHistory, lockFutureActiveBookings, reassignBookings } from './repo';
import type { ApplyBookingEffects } from './types';

export const applyBookingEffects: ApplyBookingEffects = async (tx, actor, card, effects, at) => {
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
    } else {
      // Заслуга (`booked_by_user_id`) не трогается: меняется только ответственный (D-042).
      await reassignBookings(tx, ids, e.to, at);
    }
  }
};
