// Общие помощники маршрутов передач: схемы тел (Zod) и единые ответы на ошибки домена
// (docs/deals-handoffs-design.md §6). Проверки сессии, Origin, ролей и охвата — обёртка route().
import { z } from 'zod';
import { BadRequestError, NotFoundError } from '@/server/access';
import { isDealDomainError } from '@/server/domain/deals';
import { isHandoffDomainError } from '@/server/domain/handoffs';
import { isFeatureEnabled } from '@/server/platform/flags';

export { paramId, readJson } from '../bookings/_lib';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Модуль за флагом `PURCHASES`: выключен — маршрут отвечает как несуществующий (404). */
export function requirePurchases(): void {
  if (!isFeatureEnabled('PURCHASES')) throw new NotFoundError();
}

/** Ошибка домена → ответ: плохой ввод — 400 с кодом; отказ состояния — 409 с кодом. */
export async function respond<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (e) {
    if (isHandoffDomainError(e) || isDealDomainError(e)) {
      if (e.status === 400) throw new BadRequestError(e.code);
      return Response.json({ error: 'conflict', detail: e.code }, { status: 409, headers: NO_STORE });
    }
    throw e;
  }
}

const opId = z.string().uuid();

export const AcceptBody = z.object({ opId }).strict();
/** Пустая и слишком длинная причина — код `reason_required` от сервиса; Zod только отсекает не строки. */
export const DeclineBody = z.object({ opId, reason: z.string().max(2000) }).strict();
export const AssignBody = z.object({ opId, userId: z.string().min(1).max(64) }).strict();

export const STATUS_GROUPS = {
  waiting: ['pending'],
  working: ['accepted'],
  closed: ['declined', 'cancelled'],
} as const;
