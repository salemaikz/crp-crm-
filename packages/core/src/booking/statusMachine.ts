/**
 * Автомат статусов записи: один для групповых и индивидуальных видов (PROCESS §5.3).
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/statusMachine.ts (`allowedTargets`, `checkTransition`).
 * Статусы `moved_*` слиты в `moved`; добавлены правила времени из таблицы §5.3.
 *
 * ПОЧЕМУ ЧИСТАЯ ФУНКЦИЯ С `now` ПАРАМЕТРОМ. Правила зависят от времени: «пришёл» на
 * мероприятие, которое ещё не началось, — опечатка дежурного, а не факт.
 *
 * ПЕРЕХОДЫ:
 *   registered → confirmed | moved | cancelled | attended | no_show
 *   confirmed  → registered (снять подтверждение) | moved | cancelled | attended | no_show
 *   no_show    → attended (исправление явки) | moved | cancelled
 *   attended   → no_show (дежурный ошибся)
 *   cancelled  → registered (клиент передумал; место проверит репозиторий)
 *   moved      — конечный: жизнь продолжается в новой записи (moved_to_id).
 *
 * ВРЕМЯ:
 *   • attended — не раньше начала местных суток мероприятия;
 *   • no_show — не раньше начала (до начала человек ещё может прийти);
 *   • confirmed и возврат в registered — только пока встреча не закончилась;
 *   • cancelled → registered — только пока мероприятие не началось;
 *   • attended → no_show — в течение суток мероприятия, позже только с `lateCorrection`
 *     (право решает вызывающий код: у РОП оно есть, у дежурного нет).
 */

import type { BookingStatus } from './types';
import { addWorkdays, type IsWorkday } from './calendar';
import { addDays, epochToLocalDate, localDayStart, type Tz } from './time';

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  registered: ['confirmed', 'moved', 'cancelled', 'attended', 'no_show'],
  confirmed: ['registered', 'moved', 'cancelled', 'attended', 'no_show'],
  no_show: ['attended', 'moved', 'cancelled'],
  attended: ['no_show'],
  cancelled: ['registered'],
  moved: [],
};

export type TransitionRejection = 'invalid_transition' | 'too_early' | 'too_late' | 'same_status';

export interface TransitionContext {
  tz: Tz;
  now: number;
  startsAt: number;
  durationMin: number;
  /** Можно ли править явку «Пришёл → Не пришёл» после суток мероприятия (РОП). */
  lateCorrection?: boolean;
}

export type TransitionCheck = { ok: true } | { ok: false; reason: TransitionRejection };

export function allowedTargets(from: BookingStatus): readonly BookingStatus[] {
  return TRANSITIONS[from];
}

export function checkTransition(from: BookingStatus, to: BookingStatus, ctx: TransitionContext): TransitionCheck {
  if (from === to) return { ok: false, reason: 'same_status' };
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: 'invalid_transition' };

  const endsAt = ctx.startsAt + ctx.durationMin * 60_000;
  const eventDate = epochToLocalDate(ctx.tz, ctx.startsAt);

  if (to === 'attended' && ctx.now < localDayStart(ctx.tz, eventDate)) {
    return { ok: false, reason: 'too_early' };
  }
  if (to === 'no_show') {
    if (ctx.now < ctx.startsAt) return { ok: false, reason: 'too_early' };
    if (from === 'attended' && !ctx.lateCorrection && ctx.now >= localDayStart(ctx.tz, addDays(eventDate, 1))) {
      return { ok: false, reason: 'too_late' };
    }
  }
  if (to === 'confirmed' && ctx.now >= endsAt) return { ok: false, reason: 'too_late' };
  if (to === 'registered') {
    // Снять подтверждение — пока встреча не закончилась; вернуть отменённую — пока не началась.
    const limit = from === 'cancelled' ? ctx.startsAt : endsAt;
    if (ctx.now >= limit) return { ok: false, reason: 'too_late' };
  }
  return { ok: true };
}

/** Перенос создаёт новую запись — ему нужна цель. */
export function isMove(status: BookingStatus): status is 'moved' {
  return status === 'moved';
}

/** Исправление явки «Не пришёл → Пришёл» откатывает последствия неявки (PROCESS §5.3, № 31). */
export function isAttendanceCorrection(from: BookingStatus, to: BookingStatus): boolean {
  return from === 'no_show' && to === 'attended';
}

/**
 * Автонеявка (attendance-sweep): пора ли считать неотмеченную запись «не пришёл».
 *
 * Срок: начало местных суток N-го рабочего дня после даты мероприятия
 * (`booking.attendance.autoNoShowWorkdays`; null — автонеявка выключена).
 * Обрабатываются только registered/confirmed — отмеченные и отменённые не трогаем.
 */
export function autoNoShowDue(
  b: { status: BookingStatus; startsAt: number },
  now: number,
  opts: { tz: Tz; workdays: number | null; isWorkday: IsWorkday },
): boolean {
  if (opts.workdays === null) return false;
  if (b.status !== 'registered' && b.status !== 'confirmed') return false;
  const due = addWorkdays(epochToLocalDate(opts.tz, b.startsAt), opts.workdays, opts.isWorkday);
  return now >= localDayStart(opts.tz, due);
}
