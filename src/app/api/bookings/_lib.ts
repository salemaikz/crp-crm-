// Общие помощники маршрутов записи и мероприятий: разбор тел и запросов (Zod), единые ответы на ошибки
// домена (docs/booking-design.md §10). Сами проверки сессии, Origin, ролей и охвата — обёртка route().
import { booking } from '@crm/core';
import { z } from 'zod';
import { BadRequestError, NotFoundError, type RouteParams } from '@/server/access';
import { BookingDomainError, fromCore, httpFailure } from '@/server/domain/booking';

const BODY_MAX_BYTES = 16 * 1024;

/** Тело JSON ≤ 16 КБ по схеме Zod (.strict()). Неверное тело — 400 (ZodError превращает обёртка). */
export async function readJson<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  if (text.length > BODY_MAX_BYTES) throw new BadRequestError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError('json');
  }
  return schema.parse(raw);
}

/** Строка запроса по схеме Zod; пустые значения (`?type=`) считаются отсутствующими. */
export function readQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== '') out[k] = v;
  return schema.parse(out);
}

/** id объекта из пути; нет — как несуществующий. */
export function paramId(params: RouteParams): string {
  const v = params.id;
  if (typeof v !== 'string' || v === '') throw new NotFoundError();
  return v;
}

/**
 * Ошибка домена → ответ: «не найдено» — тот же 404, что у чужого объекта; плохой запрос — 400;
 * остальное — 409 с кодом (`event_full` — и со списком альтернатив), 503 до C5.
 */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    const err = e instanceof booking.BookingError ? fromCore(e) : e;
    if (!(err instanceof BookingDomainError)) throw e;
    const f = httpFailure(err);
    if (f.kind === 'not_found') throw new NotFoundError();
    if (f.kind === 'bad_request') throw new BadRequestError(f.detail);
    return Response.json(f.body, { status: f.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

// ---------------------------------------------------------------------------
// Схемы тел и запросов
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);
const opId = z.string().uuid();
const version = z.number().int().min(0);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const format = z.enum(['offline', 'online']);
const duration = z.number().int().min(1).max(1440);
const capacity = z.number().int().min(1).max(1000);
const place = z.string().max(200);

export const GroupBookingBody = z
  .object({ kind: z.literal('group'), requestId: opId, clientId: id, eventId: id, contactId: id.nullable().default(null) })
  .strict();
export const ConfirmBody = z.object({ opId, version, to: z.enum(['confirmed', 'registered']) }).strict();
export const AttendanceBody = z.object({ opId, version, to: z.enum(['attended', 'no_show']) }).strict();
export const CancelBookingBody = z.object({ opId, version, reason: z.enum(['client', 'operator_error']) }).strict();
export const MoveBody = z.object({ requestId: opId, version, eventId: id }).strict();

export const EventBody = z
  .object({
    requestId: opId,
    eventTypeKey: id,
    eventDate: date,
    startTime: time,
    durationMin: duration.optional(),
    capacity: capacity.optional(),
    location: place.optional(),
    format: format.optional(),
  })
  .strict();
export const EventPatchBody = z
  .object({
    seenUpdatedAt: version,
    patch: z.object({ eventDate: date, startTime: time, durationMin: duration, capacity, location: place, format }).partial().strict(),
  })
  .strict();
export const CancelEventBody = z.object({ opId }).strict();
export const DutyBody = z.object({ userIds: z.array(id).max(10) }).strict();

const seriesFields = {
  eventTypeKey: id,
  weekday: z.number().int().min(1).max(7),
  startTime: time,
  durationMin: duration,
  location: place,
  format,
  capacity,
};
export const SeriesBody = z.object({ requestId: opId, ...seriesFields }).strict();
export const SeriesPatchBody = z
  .object({ seenUpdatedAt: version, patch: z.object({ ...seriesFields, active: z.boolean() }).partial().strict() })
  .strict();

export const EventsQuery = z
  .object({ from: date, to: date, type: id.optional(), cancelled: z.enum(['0', '1']).optional() })
  .strict();
export const OfferQuery = z.object({ clientId: id, type: id.optional() }).strict();
const STATUS_LIST = z
  .string()
  .transform((s) => s.split(',').filter((x) => x !== ''))
  .pipe(z.array(z.enum(booking.BOOKING_STATUSES)).max(6));
export const BookingsQuery = z.object({ from: date, to: date, status: STATUS_LIST.optional(), eventId: id.optional(), clientId: id.optional() }).strict();
