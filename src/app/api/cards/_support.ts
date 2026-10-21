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
  .object({ opId, version, kind: z.enum(['not_target', 'do_not_call']), reasonCode: z.string().min(1).max(100), alsoDncPhoneIds: z.array(z.string().min(1).max(100)).max(20) })
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
