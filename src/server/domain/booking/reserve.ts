// Резерв слота консультанта и уведомления консультаций (docs/deals-handoffs-design.md §4.7, D-245/D-246).
// Вызывается внутри транзакции действия под блокировкой дня; карточки участников резерва не блокируются:
// запись резерва меняет только флаг `is_reserve`, а порядок «карточка → день → записи» держит каждый путь записи.
import { booking as core } from '@crm/core';
import { resolveLead } from '@/server/domain/cards';
import { ensureAutoTask } from '@/server/domain/tasks/auto';
import type { Sql } from '@/server/platform/db';
import { findResourceListRow, insertHistory } from './repo';
import { insertBookingNotification, lockSlotBookings, promoteBookingRow, resourceUserOf } from './repo.consult';
import { actorUserId } from './repo';
import type { BookingActor } from './types';

/**
 * Освободилось место в слоте консультанта: повысить самый старый резерв (`core.reserveToPromote`). Слот — интервал
 * освободившейся записи. Возвращает id повышенной записи или null. Колокол: консультанту и ответственному.
 */
export async function promoteReserve(
  tx: Sql,
  actor: BookingActor,
  a: { spaceId: string; resourceId: string; date: string; startTime: string; durationMin: number; at: number },
): Promise<string | null> {
  const res = await findResourceListRow(tx, { id: a.resourceId, spaceId: a.spaceId, lock: false });
  if (!res) return null;
  const startMin = core.timeToMin(a.startTime);
  const list = await lockSlotBookings(tx, { resourceId: a.resourceId, date: a.date, startMin, endMin: startMin + a.durationMin });
  const id = core.reserveToPromote(list, res.capacity);
  if (!id) return null;
  const promoted = list.find((b) => b.id === id);
  if (!promoted) return null;
  await promoteBookingRow(tx, { id, at: a.at });
  await insertHistory(tx, {
    bookingId: id,
    action: 'promoted',
    from: promoted.status,
    to: promoted.status,
    actorId: actorUserId(actor),
    meta: { resourceId: a.resourceId },
    at: a.at,
  });
  const owner = await resourceUserOf(tx, a.resourceId);
  if (owner) await insertBookingNotification(tx, { userId: owner.userId, kind: 'reserve_promoted', bookingId: id, dedupeKey: `reserve_promoted:${id}:consultant`, at: a.at });
  if (promoted.responsibleUserId && promoted.responsibleUserId !== owner?.userId) {
    await insertBookingNotification(tx, { userId: promoted.responsibleUserId, kind: 'reserve_promoted', bookingId: id, dedupeKey: `reserve_promoted:${id}:owner`, at: a.at });
  }
  return id;
}

/** Колокол консультанту о новой записи к нему; себе не шлём. Ключ включает консультанта: переназначение уведомляет нового. */
export async function notifyConsultNew(tx: Sql, a: { bookingId: string; resourceId: string; exceptUserId: string | null; at: number }): Promise<void> {
  const owner = await resourceUserOf(tx, a.resourceId);
  if (!owner || owner.userId === a.exceptUserId) return;
  await insertBookingNotification(tx, { userId: owner.userId, kind: 'booking_consult_new', bookingId: a.bookingId, dedupeKey: `consult_new:${a.bookingId}:${a.resourceId}`, at: a.at });
}

/** Колокол автору записи: ему назначили консультанта. */
export async function notifyConsultantAssigned(tx: Sql, a: { bookingId: string; resourceId: string; authorUserId: string | null; exceptUserId: string | null; at: number }): Promise<void> {
  if (!a.authorUserId || a.authorUserId === a.exceptUserId) return;
  await insertBookingNotification(tx, { userId: a.authorUserId, kind: 'consultant_assigned', bookingId: a.bookingId, dedupeKey: `assigned:${a.bookingId}:${a.resourceId}`, at: a.at });
}

/** Ключ задачи «Назначьте консультанта» (D-247). */
export const greyTaskKey = (bookingId: string): string => `grey_unassigned:${bookingId}`;

/**
 * Задача РОП «Консультанта не подобрали»: срок — начало записи. Получатель — руководитель владельца карточки
 * (`resolveLead`); не нашёлся — предупреждение в журнал, задачи нет.
 */
export async function ensureGreyTask(
  tx: Sql,
  actor: BookingActor,
  a: { bookingId: string; spaceId: string; clientId: string; dealId: string | null; startsAt: number; ownerUserId: string | null; at: number },
): Promise<void> {
  const assignee = await resolveLead(tx, { spaceId: a.spaceId, ownerUserId: a.ownerUserId, at: a.at });
  if (!assignee) {
    console.warn('[booking] нет получателя задачи grey_unassigned: руководитель не найден');
    return;
  }
  await ensureAutoTask(tx, actor, {
    spaceId: a.spaceId,
    clientId: a.clientId,
    dealId: a.dealId,
    source: 'grey_unassigned',
    kind: 'check',
    assigneeUserId: assignee,
    dueAt: a.startsAt,
    sourceKey: greyTaskKey(a.bookingId),
    at: a.at,
  });
}

/** Колокол РОП (`grey_suggest`): режим «предлагать», один раз на заявку. Возвращает, ушёл ли колокол кому-то. */
export async function notifyGreySuggest(tx: Sql, a: { bookingId: string; spaceId: string; ownerUserId: string | null; at: number }): Promise<boolean> {
  const lead = await resolveLead(tx, { spaceId: a.spaceId, ownerUserId: a.ownerUserId, at: a.at });
  if (!lead) return false;
  await insertBookingNotification(tx, { userId: lead, kind: 'grey_suggest', bookingId: a.bookingId, dedupeKey: `grey_suggest:${a.bookingId}`, at: a.at });
  return true;
}
