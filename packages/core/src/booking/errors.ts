/**
 * Доменные ошибки записи и их HTTP-коды.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/errors.ts (убраны коды, привязанные к лидам SalemAI).
 *
 * Один класс с машиночитаемым кодом: интерфейс ветвится по `code`, а не по тексту.
 *   400 — запрос испорчен;
 *   404 — нет такой записи/мероприятия/консультанта в этом пространстве
 *         (чужой id неотличим от несуществующего);
 *   409 — запрос корректен, но состояние не позволяет: мест нет, слот занят, переход запрещён.
 */

export const BOOKING_ERROR_STATUS = {
  invalid_phone: 400,
  move_target_required: 400,
  invalid_availability: 400,
  invalid_settings: 400,
  booking_not_found: 404,
  event_not_found: 404,
  consultant_not_found: 404,
  series_not_found: 404,
  invalid_transition: 409,
  same_status: 409,
  too_early: 409,
  too_late: 409,
  event_full: 409,
  event_cancelled: 409,
  event_in_past: 409,
  already_registered: 409,
  slot_unavailable: 409,
  slot_in_past: 409,
  consultant_has_no_schedule: 409,
  consultant_inactive: 409,
  outside_hours: 409,
  no_free_consultant: 409,
  // Прямая запись к консультанту из пула оставила бы «серую» запись без свободного консультанта.
  pool_full: 409,
  consultant_unavailable: 409,
  not_an_individual_event: 409,
} as const;

export type BookingErrorCode = keyof typeof BOOKING_ERROR_STATUS;

export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BookingError';
    this.code = code;
  }

  get status(): number {
    return BOOKING_ERROR_STATUS[this.code];
  }
}
