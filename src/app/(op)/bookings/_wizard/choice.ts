// Выбор в мастере и тела запросов. Чистые функции: проверяются юнит-тестами без браузера.
import type { BookingWizardView, EventOption } from './types';

export type WizardChoice =
  | { kind: 'group'; eventTypeKey: string; event: EventOption }
  | {
      kind: 'individual';
      eventTypeKey: string;
      directionKey: string;
      date: string;
      time: string;
      /** Консультант слота (подбор за флагом BK_WIZARD); нет — «серая» заявка. */
      consultant?: { resourceId: string; name: string; reserve: boolean };
    };

/** Тело `POST /api/bookings` (путь B): ключ запроса и клиент ставит мастер. */
export function toBookingBody(view: Pick<BookingWizardView, 'clientId'>, choice: WizardChoice, requestId: string): Record<string, unknown> {
  if (choice.kind === 'group') {
    return { kind: 'group', requestId, clientId: view.clientId, eventId: choice.event.id, contactId: null };
  }
  return {
    kind: 'individual',
    requestId,
    clientId: view.clientId,
    eventTypeKey: choice.eventTypeKey,
    date: choice.date,
    time: choice.time,
    directionKey: choice.directionKey,
    resourceId: choice.consultant?.resourceId ?? null,
    contactId: null,
  };
}

/** Запись внутри итога «Договорились» (путь A, шторка): `agreement.booking` без requestId, клиента и контакта; консультант — всегда «серая». */
export function toAgreementBooking(choice: WizardChoice): Record<string, unknown> {
  if (choice.kind === 'group') return { kind: 'group', eventId: choice.event.id };
  return { kind: 'individual', eventTypeKey: choice.eventTypeKey, date: choice.date, time: choice.time, directionKey: choice.directionKey, resourceId: null };
}
