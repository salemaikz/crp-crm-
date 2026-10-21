// Общие помощники маршрутов сделок: схемы тел (Zod) и единые ответы на ошибки домена
// (docs/deals-handoffs-design.md §6). Проверки сессии, Origin, ролей и охвата — обёртка route().
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '@/server/access';
import { CardRejectedError, checkAmount, isDealDomainError } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';

export { paramId, readJson } from '../bookings/_lib';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Модуль покупок за флагом: выключен — маршрут отвечает как несуществующий (404). */
export function requirePurchases(): void {
  if (!isFeatureEnabled('PURCHASES')) throw new NotFoundError();
}

/** Сумма — целое число тенге от 0 до 1e12; строка и дробь — 400 `amount_invalid`, а не общий ответ Zod. */
export function amountOf(x: unknown): number {
  if (!checkAmount(x)) throw new BadRequestError('amount_invalid');
  return x;
}

/** Ошибка домена → ответ: плохой ввод — 400 с кодом; отказ состояния и машины карточки — 409 с кодом. */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CardRejectedError) return Response.json({ error: 'conflict', detail: e.code }, { status: 409, headers: NO_STORE });
    if (!isDealDomainError(e)) throw e;
    if (e.status === 400) throw new BadRequestError(e.code);
    const body: { error: string; detail: string; fields?: string[] } = { error: 'conflict', detail: e.code };
    if (e.code === 'stage_fields_required' && e.fields) body.fields = e.fields;
    return Response.json(body, { status: 409, headers: NO_STORE });
  }
}

// ---------------------------------------------------------------------------
// Схемы тел
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(64);
const key = z.string().min(1).max(64);
const opId = z.string().uuid();
const version = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PurchaseBody = z
  .object({ requestId: opId, cardId: id, dealId: id.nullable(), serviceTypeKey: key, amountKzt: z.unknown(), wonDay: day.nullable().default(null) })
  .strict();
export const EditPurchaseBody = z.object({ opId, version, amountKzt: z.unknown().optional(), wonDay: day.optional(), serviceTypeKey: key.optional() }).strict();
export const CancelPurchaseBody = z.object({ opId, version, mode: z.enum(['refund', 'error']), comment: z.string().trim().min(1).max(500) }).strict();
export const StageBody = z
  .object({
    opId,
    version,
    stageKey: key,
    nextStep: z.object({ dueAt: z.number().int().min(0).max(8_640_000_000_000_000), kind: z.enum(['call', 'meeting']) }).strict().nullable().default(null),
  })
  .strict();
export const LoseBody = z.object({ opId, version, reasonCode: key, reasonText: z.string().max(500).default('') }).strict();
