// Общие помощники маршрутов обзвона: разбор тел и запросов (Zod), единые ответы на ошибки домена
// (docs/calls-design.md §11). Проверки сессии, Origin, разрешений и охвата — обёртка route().
import { z } from 'zod';
import { BadRequestError, ForbiddenError, NotFoundError } from '@/server/access';
import { CallsDomainError, OUTCOME_VIAS, httpFailure, isCallsDomainError, parseDeviceHeaders, recordDeviceStatus } from '@/server/domain/calls';
import type { Viewer } from '@/server/access';
import { AgreementBookingBody, respond as respondBooking } from '../bookings/_lib';

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

export function readQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== '') out[k] = v;
  return schema.parse(out);
}

/**
 * Ошибка домена → ответ: «не найдено» — тот же 404, что у чужого объекта; проверки шторки — 400 с кодом и полем;
 * `skip_limit` и `invalid_transition` — 409. Ошибки записи («Договорились — записать») идут как у маршрутов записи.
 */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  return respondBooking(async () => {
    try {
      return await run();
    } catch (e) {
      if (!isCallsDomainError(e)) throw e;
      const f = httpFailure(e as CallsDomainError);
      if (f.kind === 'not_found') throw new NotFoundError();
      if (f.kind === 'forbidden') throw new ForbiddenError();
      return Response.json(f.body, { status: f.status, headers: { 'Cache-Control': 'no-store' } }) as unknown as T;
    }
  });
}

/** Статус устройства из заголовков: после основной работы, ошибка не меняет ответ (D-063). */
export async function noteDevice(req: Request, viewer: Viewer): Promise<void> {
  const report = parseDeviceHeaders(req.headers);
  if (report) await recordDeviceStatus(viewer, report, Date.now());
}

// ---------------------------------------------------------------------------
// Схемы
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);
const opId = z.string().uuid();
const ms = z.number().int().min(0);
const short = z.string().max(200);

const LprInfo = z.object({ name: short, phone: short, when: short }).strict();

const Agreement = z
  .object({ contactId: id.nullable(), agreedDueAt: ms.nullable(), booking: AgreementBookingBody.nullable() })
  .strict();

export const OutcomeBody = z
  .object({
    opId,
    cardId: id,
    outcomeKey: id,
    via: z.enum(OUTCOME_VIAS),
    occurredAt: ms,
    tappedAt: ms.nullable(),
    phoneId: id.nullable(),
    reasonCode: z.string().max(100),
    note: z.string().max(2000),
    lpr: z.enum(['', 'yes', 'no']),
    lprInfo: LprInfo.nullable(),
    callbackAt: ms.nullable(),
    markTarget: z.boolean(),
    alsoDncPhoneIds: z.array(id).max(10),
    fields: z.record(z.string().max(100), z.unknown()).refine((o) => Object.keys(o).length <= 20, 'too_many_fields'),
    durationSec: z.number().int().min(0).max(86_400).nullable(),
    agreement: Agreement.nullable(),
    seenVersion: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export const SkipBody = z.object({ opId, cardId: id }).strict();

const GROUP = z.enum(['all', 'callbacks', 'retries', 'new', 'returns']);
export const QueueQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(4).default(1),
    exclude: z
      .string()
      .default('')
      .transform((s) => s.split(',').filter((x) => x !== ''))
      .pipe(z.array(id).max(50)),
    group: GROUP.default('all'),
  })
  .strict();
