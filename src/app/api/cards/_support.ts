// Общее для маршрутов действий карточки: тело по схеме, отказ ядра → 400/409 с кодом (docs/tasks-team-design.md §1.1).
import { z } from 'zod';
import { isCardActionError } from '@/server/domain/cards';
import { parseBody } from '@/server/domain/clients';
import { readJson } from '../clients/_support';

const opId = z.string().uuid();
const version = z.number().int().min(0);
const comment = z.string().trim().min(1).max(500);

export const ReopenBody = z.object({ opId, version, comment, toUserId: z.string().min(1).max(100).optional() }).strict();
export const DncClearBody = z.object({ opId, version, comment }).strict();
export const CloseBody = z
  .object({ opId, version, kind: z.enum(['not_target', 'do_not_call', 'written_off']), reasonCode: z.string().min(1).max(100), alsoDncPhoneIds: z.array(z.string().min(1).max(100)).max(20) })
  .strict();

export const MoveBody = z
  .object({
    opId,
    version,
    to: z.enum(['callback', 'not_interested', 'written_off']),
    reasonCode: z.string().max(100),
    reasonText: z.string().trim().max(500).optional(),
    callbackAt: z.number().int().positive().optional(),
    callbackPrecision: z.enum(['time', 'day']).optional(),
    attendance: z.object({ bookingId: z.string().min(1).max(100), to: z.enum(['attended', 'no_show']) }).strict().optional(),
  })
  .strict();

export async function readBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  return parseBody(schema, await readJson(req));
}

/** Отказ ядра (устаревшая версия, недопустимое состояние) — ответ с кодом; остальное уходит в обёртку маршрута. */
export async function respondCard<T>(run: () => Promise<T>): Promise<Response> {
  try {
    return Response.json({ card: await run() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (!isCardActionError(e)) throw e;
    return Response.json(e.body, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

/** Параметры доски из строки запроса: `q`, `filter` (список через запятую или повтор), `owner`, `callbackReason`. */
export function parseBoardQuery(sp: URLSearchParams): { q: string | null; filter: string[]; owner: string | null; callbackReason: string | null } {
  const filter = sp.getAll('filter').flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '');
  return { q: sp.get('q'), filter, owner: sp.get('owner'), callbackReason: sp.get('callbackReason') };
}
