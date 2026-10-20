// Сетка времени заявки на консультацию (B3a, docs/booking-wizard-design.md §4): одна функция проверки слота
// для сервера и для полосы мастера — мастер не предлагает то, что сервер отклонит. Чистые функции, без БД.
import { booking } from '@crm/core';
import type { BookingCatalog, BookingSettings, ConsultDay, ConsultDays } from './types';

type ConsultSettings = BookingSettings & { catalog: BookingCatalog };

/** Старты 'HH:MM' рабочего дня по сетке `consult.slotMinutes`; нерабочий день и праздник — пусто. */
export function consultDaySlots(settings: ConsultSettings, date: string): string[] {
  const c = settings.catalog.consult;
  const plan = booking.defaultHoursDay(date, c.hours, settings.calendar.isWorkday);
  return booking.slotStarts(plan, c.slotMinutes).map(booking.minToTime);
}

/** Сегодня и последний день горизонта в поясе организации. */
export function consultWindow(settings: ConsultSettings, now: number): { today: string; last: string } {
  const today = booking.epochToLocalDate(settings.timeZone, now);
  return { today, last: booking.addDays(today, settings.horizonDays) };
}

export type SlotCheck = 'ok' | 'outside_hours' | 'slot_in_past';

/** Принимает ли сервер дату и время заявки: день в горизонте, время — слот сетки, момент в будущем. */
export function checkConsultSlot(settings: ConsultSettings, date: string, time: string, now: number): SlotCheck {
  if (!booking.isLocalDate(date) || !booking.isLocalTime(time)) return 'outside_hours';
  const { today, last } = consultWindow(settings, now);
  if (date < today || date > last) return 'outside_hours';
  if (!consultDaySlots(settings, date).includes(time)) return 'outside_hours';
  return booking.localToEpoch(settings.timeZone, date, time) <= now ? 'slot_in_past' : 'ok';
}

/** Только окно: день в горизонте и момент в будущем (время — любое; слот проверяет подбор консультанта, B5b). */
export function checkConsultWindow(settings: ConsultSettings, date: string, time: string, now: number): SlotCheck {
  if (!booking.isLocalDate(date) || !booking.isLocalTime(time)) return 'outside_hours';
  const { today, last } = consultWindow(settings, now);
  if (date < today || date > last) return 'outside_hours';
  return booking.localToEpoch(settings.timeZone, date, time) <= now ? 'slot_in_past' : 'ok';
}

/** `consult.stripDays` ближайших рабочих дней со свободными слотами; у сегодняшнего — только будущие. */
export const consultDays: ConsultDays = (settings, now) => {
  const { today } = consultWindow(settings, now);
  const out: ConsultDay[] = [];
  for (let i = 0; i <= settings.horizonDays && out.length < settings.catalog.consult.stripDays; i++) {
    const date = booking.addDays(today, i);
    const times = consultDaySlots(settings, date).filter((t) => checkConsultSlot(settings, date, t, now) === 'ok');
    if (times.length > 0) out.push({ date, times });
  }
  return out;
};
