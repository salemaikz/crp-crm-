// «Договорились» в шторке итога (D-202): запись и итог уходят одним запросом, «Запишу позже» — итогом с датой.
// Чистые функции без React и сети: проверяются юнит-тестами.
import type { WizardChoice } from '@/app/(op)/bookings/_wizard/choice';
import { toAgreementBooking } from '@/app/(op)/bookings/_wizard/choice';
import { parseBookingResponse, type WizardResult } from '@/app/(op)/bookings/_wizard/result';
import { nextWorkday } from './callback';
import type { CallConfig, OutcomeRequest } from './types';
import { addDays, fromLocal, localDay } from './zoned';

/** Во сколько ставится задача «записать» в следующий рабочий день (местное время). */
export const LATER_TIME = '10:00';

/** `agreement` итога «Договорились — записать»: запись из мастера внутри итога. */
export function bookingAgreement(contactId: string | null, choice: WizardChoice): NonNullable<OutcomeRequest['agreement']> {
  return { contactId, agreedDueAt: null, booking: toAgreementBooking(choice) as NonNullable<OutcomeRequest['agreement']>['booking'] };
}

/** «Запишу позже»: договорённость с датой без записи; ядро создаст задачу «записать» (agreement:<opId>). */
export function laterAgreement(contactId: string | null, config: Pick<CallConfig, 'timeZone' | 'calendar'>, now: number): NonNullable<OutcomeRequest['agreement']> {
  const day = nextWorkday(localDay(now, config.timeZone), config.calendar);
  const at = fromLocal(day, LATER_TIME, config.timeZone);
  // Защита от странного календаря: срок всегда в будущем
  return { contactId, agreedDueAt: at > now ? at : fromLocal(addDays(localDay(now, config.timeZone), 1), LATER_TIME, config.timeZone), booking: null };
}

/** Что делать шторке после ответа на итог с записью. */
export type AgreementOutcome =
  | { kind: 'result'; result: WizardResult }
  /** Итог принят, записи нет: карточку успели передать (`fact_only`) или повтор без записи. */
  | { kind: 'fact_only' }
  /** Сервер не принял итог (проверка шторки, чужая карточка): показать причину и вернуть к форме. */
  | { kind: 'rejected'; code: string }
  | { kind: 'login' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Ответ `POST /api/calls/outcomes` с `agreement.booking` → решение для мастера. Ошибки записи разбирает мастер записи. */
export function parseAgreementResponse(status: number, json: unknown): AgreementOutcome {
  if (status === 401) return { kind: 'login' };
  if (status === 200 && isObject(json)) {
    if (isObject(json.booking)) {
      return { kind: 'result', result: { ok: true, booking: json.booking as never, action: json.bookingAction === 'moved' ? 'moved' : 'created' } };
    }
    return { kind: 'fact_only' };
  }
  if (status === 409) {
    // Ошибки записи приходят как `detail`, отказы обзвона (`invalid_transition`) — как `code`
    if (isObject(json) && typeof json.detail !== 'string' && typeof json.code === 'string') return { kind: 'rejected', code: json.code };
    return { kind: 'result', result: parseBookingResponse(status, json) };
  }
  if (status === 400 || status === 403 || status === 404) {
    return { kind: 'rejected', code: isObject(json) && typeof json.code === 'string' ? json.code : status === 400 ? 'bad_request' : 'not_found' };
  }
  // 423, 429, 5xx, пустое тело: итог не принят, повтор тем же opId безопасен
  return { kind: 'result', result: { ok: false, code: 'network' } };
}
