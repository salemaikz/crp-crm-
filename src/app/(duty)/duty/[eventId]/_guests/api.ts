import type { DutyEventView, GuestRow } from './types';

export type Reply<T> = { ok: true; data: T; status: number } | { ok: false; code: string; status: number };

/** Запрос к API с разбором ошибки домена в машинный код (`detail` ответа; без него — `error`). */
async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, data: json as T, status: res.status };
    const code = typeof json?.detail === 'string' ? json.detail : typeof json?.error === 'string' ? json.error : 'network';
    return { ok: false, code, status: res.status };
  } catch {
    return { ok: false, code: 'network', status: 0 };
  }
}

export const newKey = (): string => globalThis.crypto.randomUUID();

export const fetchGuests = (eventId: string) => call<GuestRow[]>('GET', `/api/events/${encodeURIComponent(eventId)}/guests`);

/** Счётчики экрана: то же мероприятие из списка дежурства. */
export async function fetchEvent(eventId: string): Promise<DutyEventView | null> {
  const r = await call<DutyEventView[]>('GET', '/api/events/duty');
  return r.ok ? (r.data.find((e) => e.id === eventId) ?? null) : null;
}

export const markAttendance = (bookingId: string, version: number, to: 'attended' | 'no_show') =>
  call<unknown>('POST', `/api/bookings/${encodeURIComponent(bookingId)}/attendance`, { opId: newKey(), version, to });

export const markRest = (eventId: string, bookingIds: string[]) =>
  call<{ marked: number; skipped: number }>('POST', `/api/events/${encodeURIComponent(eventId)}/no-show-rest`, { opId: newKey(), bookingIds });

export const postWalkIn = (eventId: string, body: { requestId: string; phone: string; name: string; company: string }) =>
  call<{ answer: 'found' | 'new' | 'recorded'; replayed: boolean }>('POST', `/api/events/${encodeURIComponent(eventId)}/walk-in`, body);
