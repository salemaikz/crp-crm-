// Ошибки домена записи и их HTTP-представление (docs/booking-design.md §10).
// Домен бросает BookingDomainError; маршруты превращают её в ответ (src/app/api/bookings/_lib.ts).
import { booking } from '@crm/core';
import type { SuggestedConsultant } from './consultTypes';
import type { BookingDomainErrorCode, BookingFailure, EventOption } from './types';

/** HTTP-статус кода. Расхождение с ядром одно: `invalid_settings` — 409, а не 400 (§10). */
export const BOOKING_HTTP_STATUS: Readonly<Record<BookingDomainErrorCode, number>> = {
  ...booking.BOOKING_ERROR_STATUS,
  invalid_settings: 409,
  outcome_required: 409,
  request_reused: 409,
  event_has_bookings: 409,
  capacity_below_taken: 409,
  card_port_unavailable: 503,
  // B4/B5 (docs/deals-handoffs-design.md §6): отказы состояния — 409, плохой ввод расписания — 400
  slot_taken: 409,
  consultant_exists: 409,
  schedule_overlap: 400,
  not_attended: 409,
  walk_in_closed: 409,
  walk_in_source_missing: 409,
};

export class BookingDomainError extends Error implements BookingFailure {
  readonly code: BookingDomainErrorCode;
  readonly alternatives?: EventOption[];
  readonly suggestions?: SuggestedConsultant[];

  constructor(code: BookingDomainErrorCode, alternatives?: EventOption[], suggestions?: SuggestedConsultant[]) {
    super(code);
    this.name = 'BookingDomainError';
    this.code = code;
    if (alternatives) this.alternatives = alternatives;
    if (suggestions) this.suggestions = suggestions;
  }

  get status(): number {
    return BOOKING_HTTP_STATUS[this.code];
  }
}

/** Ошибка ядра → ошибка домена (тот же код). */
export function fromCore(e: booking.BookingError): BookingDomainError {
  return new BookingDomainError(e.code);
}

export function isBookingDomainError(e: unknown): e is BookingDomainError {
  return e instanceof BookingDomainError || (e instanceof Error && e.name === 'BookingDomainError' && 'code' in e);
}

/** Коды «не найдено»: ответ байт в байт как у несуществующего объекта (D-017). */
const NOT_FOUND_CODES: ReadonlySet<BookingDomainErrorCode> = new Set(['booking_not_found', 'event_not_found', 'series_not_found', 'consultant_not_found']);

/** Коды плохого запроса. */
const BAD_REQUEST_CODES: ReadonlySet<BookingDomainErrorCode> = new Set(['invalid_phone', 'move_target_required', 'invalid_availability', 'schedule_overlap']);

export type HttpFailure =
  | { kind: 'not_found' }
  | { kind: 'bad_request'; detail: string }
  | { kind: 'response'; status: number; body: { error: string; detail: string; alternatives?: EventOption[] | SuggestedConsultant[] } };

/** Что отдать на ошибку домена (§10). */
export function httpFailure(e: BookingDomainError): HttpFailure {
  if (NOT_FOUND_CODES.has(e.code)) return { kind: 'not_found' };
  if (BAD_REQUEST_CODES.has(e.code)) return { kind: 'bad_request', detail: e.code };
  if (e.code === 'card_port_unavailable') return { kind: 'response', status: 503, body: { error: 'internal', detail: e.code } };
  const body: { error: string; detail: string; alternatives?: EventOption[] | SuggestedConsultant[] } = { error: 'conflict', detail: e.code };
  if (e.code === 'event_full' && e.alternatives) body.alternatives = e.alternatives;
  if (e.code === 'slot_taken' && e.suggestions) body.alternatives = e.suggestions;
  return { kind: 'response', status: e.status, body };
}
