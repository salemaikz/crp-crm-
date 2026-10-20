/**
 * Групповые мероприятия: места, предложение ближайших, проверка записи, перенос вместо второй записи.
 *
 * Новая логика по PROCESS §5.1 (чистые решения; транзакции и блокировки — в репозитории).
 */

import type { BookingStatus, EventLite } from './types';
import { isActive, isOccupying } from './types';

export interface Seats {
  capacity: number;
  taken: number;
  /** Осталось мест («осталось 12 из 30»); не меньше нуля. */
  left: number;
}

/** Места мероприятия. `taken` — число записей, держащих место (registered, confirmed, attended, no_show). */
export function seats(capacity: number, taken: number): Seats {
  return { capacity, taken, left: Math.max(0, capacity - taken) };
}

/** Сколько мест держат записи: по статусам (резервы групповых мероприятий не бывает). */
export function countTaken(statuses: readonly BookingStatus[]): number {
  return statuses.filter(isOccupying).length;
}

export type EventBookability = { ok: true } | { ok: false; reason: 'event_cancelled' | 'event_in_past' | 'event_full' };

/** Можно ли записать на мероприятие: не отменено, не началось, есть места. */
export function eventBookability(event: Pick<EventLite, 'status' | 'startsAt' | 'capacity'>, taken: number, now: number): EventBookability {
  if (event.status === 'cancelled') return { ok: false, reason: 'event_cancelled' };
  if (event.startsAt <= now) return { ok: false, reason: 'event_in_past' };
  if (taken >= event.capacity) return { ok: false, reason: 'event_full' };
  return { ok: true };
}

export type EventWithTaken = EventLite & { taken: number };

/**
 * Ближайшие `count` (`booking.groupOptions`) мероприятий с местами для мастера записи; полные,
 * отменённые и прошедшие пропускаются. `eventTypeKey` сужает выбор видом.
 */
export function offerEvents(events: readonly EventWithTaken[], now: number, count: number, eventTypeKey?: string): EventWithTaken[] {
  return events
    .filter((e) => (eventTypeKey === undefined || e.eventTypeKey === eventTypeKey) && eventBookability(e, e.taken, now).ok)
    .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, count));
}

/** Запись клиента в объёме, нужном для решения «новая или перенос». */
export interface ClientBookingLite {
  id: string;
  status: BookingStatus;
  eventTypeKey: string;
  eventId: string | null;
  startsAt: number;
  bookedByUserId: string;
}

export type RepeatDecision =
  | { action: 'create' }
  | { action: 'move'; fromBookingId: string; bookedByUserId: string }
  | { action: 'reject'; reason: 'already_registered' };

/**
 * Что делать с новой записью клиента на мероприятие (PROCESS §5.1, 12.18):
 *   • тот же клиент уже держит место на ЭТОМ мероприятии — отказ (`already_registered`);
 *   • есть активная будущая запись на этот вид — это ПЕРЕНОС, а не вторая запись; автор
 *     (заслуга за запись) остаётся от исходной;
 *   • иначе — новая запись.
 * Вызывается под блокировкой клиента: «будущая» зависит от времени, индексом это не выразить.
 */
export function resolveRepeatBooking(
  existing: readonly ClientBookingLite[],
  target: { eventTypeKey: string; eventId: string | null },
  now: number,
): RepeatDecision {
  if (target.eventId && existing.some((b) => b.eventId === target.eventId && isOccupying(b.status))) {
    return { action: 'reject', reason: 'already_registered' };
  }
  const from = existing
    .filter((b) => b.eventTypeKey === target.eventTypeKey && isActive(b.status) && b.startsAt > now)
    .sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))[0];
  return from ? { action: 'move', fromBookingId: from.id, bookedByUserId: from.bookedByUserId } : { action: 'create' };
}

/** Отмена мероприятия (PROCESS §5.1): активные записи → «отменена: мероприятие отменено». */
export function bookingsToCancelOnEventCancel<T extends { status: BookingStatus }>(bookings: readonly T[]): T[] {
  return bookings.filter((b) => isActive(b.status));
}
