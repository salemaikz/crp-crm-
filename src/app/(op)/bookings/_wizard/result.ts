// Разбор ответов сервера мастера записи и запросы к API. Разбор — чистая функция (юнит-тесты).
import type { BookingDomainErrorCode, BookingView, BookingWizardView, ConsultStripDay, EventOption, OfferResult } from './types';

export type WizardAction = 'created' | 'moved';

export type WizardResult =
  | { ok: true; booking: BookingView; action: WizardAction }
  | { ok: false; code: 'event_full'; alternatives: EventOption[] }
  | { ok: false; code: BookingDomainErrorCode | 'network' | 'handled' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Ответ `POST /api/bookings` (201 — создано, 200 — повтор ключа) или итога с записью → результат мастера. */
export function parseBookingResponse(status: number, json: unknown): WizardResult {
  if ((status === 200 || status === 201) && isObject(json) && isObject(json.booking)) {
    return { ok: true, booking: json.booking as unknown as BookingView, action: json.action === 'moved' ? 'moved' : 'created' };
  }
  if (status === 409 && isObject(json) && typeof json.detail === 'string') {
    if (json.detail === 'event_full') {
      return { ok: false, code: 'event_full', alternatives: Array.isArray(json.alternatives) ? (json.alternatives as EventOption[]) : [] };
    }
    return { ok: false, code: json.detail as BookingDomainErrorCode };
  }
  // 5xx, 4xx без кода домена, пустое тело: запись не отправлена, повтор тем же ключом безопасен
  return { ok: false, code: 'network' };
}

async function request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

export async function postBooking(body: Record<string, unknown>): Promise<WizardResult> {
  const r = await request('POST', '/api/bookings', body);
  return r ? parseBookingResponse(r.status, r.json) : { ok: false, code: 'network' };
}

export async function fetchWizard(cardId: string): Promise<BookingWizardView | null> {
  const r = await request('GET', `/api/bookings/wizard/${encodeURIComponent(cardId)}`);
  return r && r.status === 200 ? (r.json as BookingWizardView) : null;
}

export async function fetchOffer(clientId: string, type: string): Promise<OfferResult | null> {
  const r = await request('GET', `/api/events/offer?clientId=${encodeURIComponent(clientId)}&type=${encodeURIComponent(type)}`);
  return r && r.status === 200 ? (r.json as OfferResult) : null;
}

/** Полоса подбора консультанта (за флагом BK_WIZARD): дни, времена, предложенный консультант. null — не удалось. */
export async function fetchConsultStrip(cardId: string, type: string, direction: string): Promise<ConsultStripDay[] | null> {
  const r = await request('GET', `/api/bookings/wizard/${encodeURIComponent(cardId)}/consult?type=${encodeURIComponent(type)}&direction=${encodeURIComponent(direction)}`);
  return r && r.status === 200 && isObject(r.json) && Array.isArray(r.json.days) ? (r.json.days as ConsultStripDay[]) : null;
}

/** Отмена записи как ошибки оператора (окно 10 минут и автора проверяет сервер, PROCESS 12.7). */
export async function cancelAsOperatorError(booking: Pick<BookingView, 'id' | 'version'>): Promise<boolean> {
  const r = await request('POST', `/api/bookings/${encodeURIComponent(booking.id)}/cancel`, {
    opId: globalThis.crypto.randomUUID(),
    version: booking.version,
    reason: 'operator_error',
  });
  return r !== null && r.status === 200;
}
